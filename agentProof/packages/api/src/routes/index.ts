import type { ServerResponse } from 'node:http';
import type {
  AgentProof,
  PolicyEngine,
  PolicyResult,
  ProofRegistry,
  ResolvedPolicy,
  StateProvider,
} from '@agentproof/sdk';
import { utcDay } from '@agentproof/sdk';
import { respondJson } from '../x402/middleware.ts';

export interface RouteContext {
  engine: PolicyEngine;
  policy: ResolvedPolicy;
  state: StateProvider;
  proofs: ProofRegistry;
  /** Policies this deployment cannot evaluate, and why. Reported, never hidden. */
  unevaluatedPolicies?: Array<{ policy: string; reason: string }>;
  mode: 'simulation' | 'production';
  agentProof?: AgentProof;
  /** resolves an ENS name to its live policy document */
  resolvePolicyByName?: (name: string) => Promise<unknown>;
  /** reads the hook's accumulator directly, for the reconciliation view */
  readOnchainSpend?: (account: string) => Promise<bigint | undefined>;
  /**
   * Pool state for a swap's pair, from a public Uniswap subgraph.
   * Absent when no UNISWAP_SUBGRAPH_ENDPOINT is configured.
   */
  poolFor?: (intent: import('@agentproof/sdk').NormalizedIntent) => Promise<
    import('@agentproof/sdk').PoolState | null | undefined
  >;
}

/**
 * POST /v1/verify — the paid route.
 *
 * A thin wrapper over the same PolicyEngine the SDK uses. There is exactly one
 * implementation of every decision in this repo; this route is a second product
 * surface, not a second product.
 */
export interface VerifyOutcome {
  /** The wire response. */
  body: unknown;
  /** The engine's own result, with bigints intact, for the audit trail. */
  result: PolicyResult;
}

export async function verifyRoute(
  ctx: RouteContext,
  body: { agent?: string; action?: Record<string, unknown> },
): Promise<VerifyOutcome> {
  if (body.agent !== undefined && body.agent !== ctx.policy.document.agent) {
    throw new BadRequestError(`unknown agent ${JSON.stringify(body.agent)}; expected ${ctx.policy.document.agent}`);
  }
  const action = parseAction(body.action);
  const dayUtc = utcDay(Date.now());

  const [dailySpend, balance] = await Promise.all([
    ctx.state.getDailySpend(ctx.policy.account, dayUtc),
    ctx.state.getBalance(ctx.policy.account, ctx.policy.asset),
  ]);

  // The pool read needs a decoded intent, so it happens between decode and
  // evaluate rather than alongside the state reads above.
  const intent = ctx.engine.decode(action);
  const pool = ctx.poolFor ? await ctx.poolFor(intent) : undefined;

  const result = ctx.engine.verify(action, {
    account: ctx.policy.account,
    dayUtc,
    dailySpend,
    balance,
    asset: ctx.policy.asset,
    now: Date.now(),
    pool,
  });

  const wire = {
    decision: result.decision,
    reason: result.reason,
    violations: result.violations,
    policyRows: result.policyRows.map(serialisePolicyRow),
    intent: serialiseIntent(result.intent),
    proof: result.proof,
    // Restated on every response so a consumer cannot mistake this for the
    // enforcement layer. The hook on the account is the boundary.
    enforcement: {
      advisory: true,
      note: 'This endpoint is advisory. Enforcement is the ERC-7579 hook installed on the account.',
      hook: ctx.policy.hook,
      account: ctx.policy.account,
      mode: ctx.mode,
      // A caller must be able to tell the difference between "this passed every
      // policy" and "this passed every policy we were able to check".
      unevaluatedPolicies: ctx.unevaluatedPolicies ?? [],
    },
  };

  return { body: wire, result };
}

/** POST /v1/decode — calldata to normalized intent, no state required. */
export async function decodeRoute(ctx: RouteContext, body: Record<string, unknown>): Promise<unknown> {
  return { intent: serialiseIntent(ctx.engine.decode(parseAction(body))) };
}

/** GET /v1/policy/:name — the live policy, resolved through ENS. */
export async function policyRoute(ctx: RouteContext, name: string): Promise<unknown> {
  if (ctx.resolvePolicyByName) {
    return { name, policy: await ctx.resolvePolicyByName(name), policyHash: ctx.policy.hash };
  }
  return { name, policy: ctx.policy.document, policyHash: ctx.policy.hash };
}

/** GET /v1/spend/:account — the Graph/chain reconciliation view. */
export async function spendRoute(ctx: RouteContext, account: string): Promise<unknown> {
  const dayUtc = utcDay(Date.now());
  const spentGraph = await ctx.state.getDailySpend(account as `0x${string}`, dayUtc);
  const spentOnchain = await ctx.readOnchainSpend?.(account);

  return {
    account,
    dayUtc,
    spentGraph: spentGraph.toString(),
    spentOnchain: spentOnchain?.toString() ?? null,
    reconciled: spentOnchain === undefined ? null : spentGraph === spentOnchain,
    limit: ctx.policy.dailySpend.toString(),
    remaining: (ctx.policy.dailySpend > spentGraph ? ctx.policy.dailySpend - spentGraph : 0n).toString(),
  };
}

/** GET /v1/proofs — whatever the verifier actually produced. */
export async function proofsRoute(ctx: RouteContext): Promise<unknown> {
  return { proofs: ctx.proofs.all(), allProven: ctx.proofs.allProven };
}

// ----------------------------------------------------------------- helpers

export class BadRequestError extends Error {}

function parseAction(input: unknown): {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  chainId: number;
} {
  if (typeof input !== 'object' || input === null) throw new BadRequestError('body.action must be an object');
  const record = input as Record<string, unknown>;

  const to = record.to;
  const data = record.data ?? '0x';
  if (typeof to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(to)) {
    throw new BadRequestError('action.to must be a 20-byte address');
  }
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(data)) {
    throw new BadRequestError('action.data must be 0x-prefixed hex');
  }

  let value = 0n;
  if (record.value !== undefined) {
    try {
      value = BigInt(record.value as string);
    } catch {
      throw new BadRequestError('action.value must be an integer string of wei');
    }
  }

  return {
    to: to.toLowerCase() as `0x${string}`,
    data: data as `0x${string}`,
    value,
    chainId: Number(record.chainId ?? 11_155_111),
  };
}

function serialiseIntent(intent: import('@agentproof/sdk').NormalizedIntent) {
  return {
    kind: intent.kind,
    target: intent.target,
    selector: intent.selector,
    counterparty: intent.counterparty,
    nativeValue: intent.nativeValue.toString(),
    notionalUSDC: intent.notionalUSDC.toString(),
    summary: intent.summary,
    outflow: intent.outflow.map((flow) => ({
      asset: flow.asset,
      amount: flow.amount.toString(),
      provenance: flow.provenance,
    })),
  };
}

function serialisePolicyRow(row: import('@agentproof/sdk').PolicyRow) {
  return {
    ...row,
    limit: row.limit?.toString(),
    observed: row.observed?.toString(),
  };
}

export async function respondError(res: ServerResponse, error: unknown): Promise<void> {
  const status = error instanceof BadRequestError ? 400 : /unreachable|unavailable|Cannot determine/i.test(String(error)) ? 503 : 500;
  const message = error instanceof Error ? error.message : 'Unexpected error';
  // Never echo the request body back; it may carry calldata a caller considers
  // sensitive, and a 500 is not a reason to start logging payloads.
  await respondJson(res, status, { error: message });
}
