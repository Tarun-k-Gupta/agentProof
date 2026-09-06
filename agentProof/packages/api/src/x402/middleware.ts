import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Logger } from '@agentproof/sdk';
import { Blocky402Facilitator, type PaymentRequirements } from './blocky402.ts';

export interface X402Options {
  facilitator: Blocky402Facilitator;
  network: string;
  asset: string;
  payTo: string;
  /** price per call, in the asset's display units, e.g. '0.01' */
  price: string;
  baseUrl: string;
  logger?: Logger;
  /** disables gating entirely; used only for local development */
  enabled: boolean;
}

/**
 * x402 gating.
 *
 * Two ordering decisions carry the whole design:
 *
 *   verify BEFORE the work — so an invalid payload costs us nothing
 *   settle AFTER the work  — so a caller is never charged for a request that
 *                            failed. Settling first would be simpler and would
 *                            quietly turn every outage into revenue.
 *
 * The framing that matters more than either: this endpoint is advisory L1 for
 * agents that cannot embed the SDK. An HTTP "is this safe?" service is, on its
 * own, exactly the bypassable application-level guardrail this project argues
 * against. The boundary is the on-chain hook. Say so in the README, in the
 * video, and here.
 */
export function createX402Gate(options: X402Options) {
  return async function gate(
    req: IncomingMessage,
    res: ServerResponse,
    resource: string,
    work: () => Promise<unknown>,
  ): Promise<void> {
    if (!options.enabled) {
      await respondJson(res, 200, await work());
      return;
    }

    const requirements: PaymentRequirements = {
      scheme: 'exact',
      network: options.network,
      asset: options.asset,
      amount: options.price,
      payTo: options.payTo,
      resource: `${options.baseUrl}${resource}`,
      description: 'AgentProof policy verification, metered per call',
      maxTimeoutSeconds: 60,
      facilitator: 'blocky402',
      nonce: randomUUID(),
    };

    const header = req.headers['x-payment'];
    if (typeof header !== 'string' || header.length === 0) {
      await respondJson(res, 402, {
        x402Version: 1,
        error: 'Payment required',
        accepts: [requirements],
      });
      return;
    }

    const verification = await options.facilitator.verify(header, requirements);
    if (!verification.valid) {
      await respondJson(res, 402, {
        x402Version: 1,
        error: verification.reason ?? 'Payment verification failed',
        accepts: [requirements],
      });
      return;
    }

    const result = await work();

    const settlement = await options.facilitator.settle(header, requirements);
    if (!settlement.settled) {
      options.logger?.log('warn', 'work completed but settlement failed', { reason: settlement.reason });
    }

    res.setHeader(
      'X-PAYMENT-RESPONSE',
      Buffer.from(JSON.stringify({ success: settlement.settled, transaction: settlement.transactionId })).toString(
        'base64',
      ),
    );
    await respondJson(res, 200, result);
  };
}

export async function respondJson(res: ServerResponse, status: number, body: unknown): Promise<void> {
  const payload = JSON.stringify(body, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    // The API is stateless and holds nothing; say so in headers too.
    'X-AgentProof-Stateless': 'true',
  });
  res.end(payload);
}
