import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ConsoleLogger,
  MemoryStateProvider,
  PolicyEngine,
  ProofRegistry,
  createDefaultRegistry,
  resolvePolicy,
  AllowlistPolicy,
  ApprovalThresholdPolicy,
  DailySpendPolicy,
  MaxTransactionPolicy,
  MinBalancePolicy,
  type PolicyDocument,
} from '@agentproof/sdk';
import { Blocky402Facilitator } from './x402/blocky402.ts';
import { createX402Gate, respondJson } from './x402/middleware.ts';
import { HcsAuditTrail, createHederaSubmitter } from './x402/hcsAudit.ts';
import {
  decodeRoute,
  policyRoute,
  proofsRoute,
  respondError,
  spendRoute,
  verifyRoute,
  type RouteContext,
} from './routes/index.ts';
import { fetchHttpClient } from './http.ts';

/**
 * The AgentProof Verification API.
 *
 * Built on node:http with no framework, for the same reason the SDK core has no
 * dependencies: this service is the thing being sold over x402, it holds no
 * keys and signs nothing, and its dependency list is part of its security
 * story. Fewer moving parts is the feature.
 *
 * Routes
 *   POST /v1/verify           x402-gated   full policy decision
 *   POST /v1/decode           x402-gated   calldata to normalized intent
 *   GET  /v1/policy/:name     free         live policy, resolved through ENS
 *   GET  /v1/spend/:account   free         Graph/chain reconciliation
 *   GET  /v1/proofs           free         current proof artifacts
 *   GET  /health              free
 */

const here = dirname(fileURLToPath(import.meta.url));

export interface ServerOptions {
  policy: PolicyDocument;
  port?: number;
  x402?: {
    enabled: boolean;
    facilitatorUrl: string;
    network: string;
    asset: string;
    payTo: string;
    priceVerify: string;
    priceDecode: string;
    baseUrl: string;
  };
  hedera?: { accountId: string; privateKey: string; topicId: string; network: 'testnet' | 'mainnet' };
}

export async function createApiServer(options: ServerOptions) {
  const logger = new ConsoleLogger('info');
  const policy = resolvePolicy(options.policy);
  const state = new MemoryStateProvider();
  const proofs = await ProofRegistry.load(join(here, '../../../proofs'));

  const engine = new PolicyEngine({
    decoders: createDefaultRegistry(),
    decoderContext: { account: policy.account, trackedAsset: policy.asset, decimals: policy.decimals },
    proofs: proofs.asMap(),
    policies: [
      new AllowlistPolicy(policy.allowedContracts, policy.allowedRecipients),
      new MaxTransactionPolicy(policy.maxTransaction),
      new MinBalancePolicy(policy.minBalance),
      new DailySpendPolicy(policy.dailySpend),
      new ApprovalThresholdPolicy(policy.approvalThreshold),
    ],
  });

  const context: RouteContext = { engine, policy, state, proofs };

  // --- x402 -----------------------------------------------------------------
  let gate: ReturnType<typeof createX402Gate> | undefined;
  if (options.x402) {
    const facilitator = new Blocky402Facilitator({
      baseUrl: options.x402.facilitatorUrl,
      http: fetchHttpClient,
      logger,
      network: options.x402.network,
    });

    if (options.x402.enabled) {
      // Fail fast rather than serving challenges we cannot settle.
      await facilitator.assertSupported();
    }

    gate = createX402Gate({
      facilitator,
      network: options.x402.network,
      asset: options.x402.asset,
      payTo: options.x402.payTo,
      price: options.x402.priceVerify,
      baseUrl: options.x402.baseUrl,
      logger,
      enabled: options.x402.enabled,
    });
  }

  // --- HCS audit ------------------------------------------------------------
  let audit: HcsAuditTrail | undefined;
  if (options.hedera?.topicId) {
    try {
      const submitter = await createHederaSubmitter(options.hedera);
      audit = new HcsAuditTrail({ topicId: options.hedera.topicId, submitter, logger, enabled: true });
      logger.log('info', 'HCS audit trail enabled', { topicId: options.hedera.topicId });
    } catch (error) {
      logger.log('warn', 'HCS audit disabled: Hedera SDK unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (error) {
      await respondError(res, error);
    }
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (path === '/health') {
      await respondJson(res, 200, {
        ok: true,
        policyHash: policy.hash,
        agent: options.policy.agent,
        proofs: proofs.all().map((p) => ({ property: p.property, status: p.status })),
        x402: options.x402?.enabled ?? false,
      });
      return;
    }

    if (path === '/' || path === '/dashboard') {
      const html = await readFile(join(here, '../public/dashboard.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (path === '/v1/verify' && req.method === 'POST') {
      const body = await readJson(req);
      const work = () => verifyRoute(context, body as { action?: Record<string, unknown> });
      if (gate) await gate(req, res, '/v1/verify', work);
      else await respondJson(res, 200, await work());
      return;
    }

    if (path === '/v1/decode' && req.method === 'POST') {
      const body = await readJson(req);
      const work = () => decodeRoute(context, body as Record<string, unknown>);
      if (gate) await gate(req, res, '/v1/decode', work);
      else await respondJson(res, 200, await work());
      return;
    }

    const policyMatch = path.match(/^\/v1\/policy\/(.+)$/);
    if (policyMatch && req.method === 'GET') {
      await respondJson(res, 200, await policyRoute(context, decodeURIComponent(policyMatch[1])));
      return;
    }

    const spendMatch = path.match(/^\/v1\/spend\/(0x[0-9a-fA-F]{40})$/);
    if (spendMatch && req.method === 'GET') {
      await respondJson(res, 200, await spendRoute(context, spendMatch[1]));
      return;
    }

    if (path === '/v1/proofs' && req.method === 'GET') {
      await respondJson(res, 200, await proofsRoute(context));
      return;
    }

    await respondJson(res, 404, { error: `No route for ${req.method} ${path}` });
  }

  return {
    server,
    audit,
    policyHash: policy.hash,
    listen(port = options.port ?? 8402): Promise<void> {
      return new Promise((resolve) => {
        server.listen(port, () => {
          logger.log('info', 'AgentProof Verification API listening', {
            port,
            x402: options.x402?.enabled ?? false,
            policyHash: policy.hash,
          });
          resolve();
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-PAYMENT',
    'Access-Control-Expose-Headers': 'X-PAYMENT-RESPONSE',
  };
}

/** Bounded body reader. An unbounded one is a denial-of-service waiting to be found. */
async function readJson(req: IncomingMessage, limitBytes = 256 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error('Request body exceeds 256 KB');
    chunks.push(chunk as Buffer);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Request body is not valid JSON');
  }
}
