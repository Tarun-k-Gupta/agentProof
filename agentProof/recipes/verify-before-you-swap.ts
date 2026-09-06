/**
 * Recipe: verify before you swap.
 *
 *   pnpm recipe:verify-before-you-swap
 *
 * The smallest useful thing an agent framework can do with AgentProof: take a
 * swap somebody else's router quoted, ask what it would actually cost, ask
 * whether policy permits it, and either execute or stop. Four steps, one of
 * which is allowed to say no.
 *
 * Written to be lifted. It talks to the public Verification API over HTTP and
 * imports nothing from this repo's internals, so a Bazantic gateway — or any
 * other agent runtime — can run it against a hosted AgentProof without adopting
 * the SDK. See docs/integrations/bazantic.md for the gateway wiring and the
 * account prerequisites, which are external to this repository.
 *
 * The framing matters as much as the code: this endpoint is advisory. It is the
 * layer for agents that cannot embed the SDK, and it is bypassable by anything
 * that chooses not to call it. The boundary is the ERC-7579 hook installed on
 * the account, which is why step 4 stops rather than warns.
 *
 * Environment:
 *   AGENTPROOF_API_URL   default http://localhost:8402
 *   AGENT_NAME           default trader.agentproof.eth
 *   X_PAYMENT            an x402 payment payload, if the API is priced
 *   TOKEN_RISK_API_URL   optional; see riskMetadata() below
 */

const API = process.env.AGENTPROOF_API_URL ?? 'http://localhost:8402';
const AGENT = process.env.AGENT_NAME ?? 'trader.agentproof.eth';
const PAYMENT = process.env.X_PAYMENT;

export interface SwapQuote {
  /** the router the swap would be sent to */
  to: string;
  /** the router calldata, exactly as the quoting service produced it */
  data: string;
  /** native value attached, in wei */
  value?: string;
  chainId?: number;
}

export interface NormalizedIntent {
  kind: 'SWAP' | 'TRANSFER' | 'APPROVE' | 'NATIVE' | 'UNKNOWN';
  target: string;
  counterparty?: string;
  notionalUSDC: string;
  summary: string;
  outflow: Array<{ asset: string; amount: string; provenance: string }>;
}

export interface PolicyRow {
  id: string;
  name: string;
  decision: 'ALLOW' | 'BLOCK' | 'REQUIRE_APPROVAL';
  passed: boolean;
  formallyVerified: boolean;
  reason?: string;
  limit?: string;
  observed?: string;
  provenance?: string;
}

export interface Verdict {
  decision: 'ALLOW' | 'BLOCK' | 'REQUIRE_APPROVAL';
  reason?: string;
  violations: unknown[];
  policyRows: PolicyRow[];
  intent: NormalizedIntent;
  enforcement: {
    advisory: boolean;
    note: string;
    hook: string;
    account: string;
    mode: string;
    unevaluatedPolicies: Array<{ policy: string; reason: string }>;
  };
}

class AgentProofUnavailable extends Error {}

async function call<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(PAYMENT ? { 'X-PAYMENT': PAYMENT } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (response.status === 402) {
    const challenge = (await response.json()) as { accepts?: Array<{ amount: string; network: string }> };
    const price = challenge.accepts?.[0];
    throw new AgentProofUnavailable(
      `${path} is priced at ${price?.amount ?? '?'} on ${price?.network ?? '?'}. ` +
        'Set X_PAYMENT to an x402 payload — see packages/x402-client.',
    );
  }
  if (!response.ok) {
    throw new AgentProofUnavailable(`${path} returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

/** Step 2 — what would this calldata actually cost, at worst? */
export async function decode(quote: SwapQuote): Promise<NormalizedIntent> {
  const { intent } = await call<{ intent: NormalizedIntent }>('/v1/decode', {
    to: quote.to,
    data: quote.data,
    value: quote.value ?? '0',
    chainId: quote.chainId ?? 11155111,
  });
  return intent;
}

/** Step 3 — does policy permit it, given today's spend and the live balance? */
export async function verify(quote: SwapQuote): Promise<Verdict> {
  return call<Verdict>('/v1/verify', {
    agent: AGENT,
    action: {
      to: quote.to,
      data: quote.data,
      value: quote.value ?? '0',
      chainId: quote.chainId ?? 11155111,
    },
  });
}

/**
 * Optional token-risk metadata.
 *
 * Deliberately *not* a new policy type. A risk score is an opinion from a third
 * party, and turning an opinion into an autonomous block invents a policy the
 * owner never wrote. What it does instead is annotate the counterparty so the
 * owner sees it on the approval screen, and — where the gateway is configured
 * to do so — feed the existing allowlist decision, which the owner does control.
 *
 * Returns undefined when no risk API is configured, which is the default.
 */
export async function riskMetadata(intent: NormalizedIntent): Promise<{ counterparty: string; note: string } | undefined> {
  const url = process.env.TOKEN_RISK_API_URL;
  if (!url || !intent.counterparty) return undefined;

  try {
    const response = await fetch(`${url}/${intent.counterparty}`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { risk?: string; labels?: string[] };
    return {
      counterparty: intent.counterparty,
      note: [body.risk, ...(body.labels ?? [])].filter(Boolean).join(', ') || 'no labels',
    };
  } catch {
    // A risk service that is down must not become a reason to block, and must
    // not become a reason to proceed either. It is metadata; its absence is
    // reported and the policy decision is unaffected.
    return undefined;
  }
}

/**
 * Step 4 — execute or stop.
 *
 * `execute` is supplied by the caller and is the only part of this recipe that
 * moves money. It is never called on BLOCK, and on REQUIRE_APPROVAL it is
 * called only after the caller's own approval flow returns true.
 */
export async function verifyBeforeYouSwap(options: {
  quote: SwapQuote;
  execute: (quote: SwapQuote) => Promise<string>;
  approve?: (verdict: Verdict) => Promise<boolean>;
  log?: (line: string) => void;
}): Promise<{ executed: boolean; reason: string; txHash?: string; verdict?: Verdict }> {
  const log = options.log ?? ((line: string) => console.log(line));

  // 1. The quote. Produced elsewhere — by the Universal Router SDK, an
  //    aggregator, or a Bazantic gateway tool call. We take it as given.
  log(`quote      ${options.quote.to} (${options.quote.data.length / 2 - 1} bytes of calldata)`);

  let intent: NormalizedIntent;
  let verdict: Verdict;
  try {
    // 2. Decode.
    intent = await decode(options.quote);
    log(`decoded    ${intent.summary}`);

    const risk = await riskMetadata(intent);
    if (risk) log(`risk       ${risk.counterparty}: ${risk.note}`);

    // 3. Verify.
    verdict = await verify(options.quote);
  } catch (error) {
    // Fail closed. An agent that cannot get an answer has not got a yes.
    const reason = error instanceof Error ? error.message : String(error);
    log(`stopped    AgentProof is unreachable: ${reason}`);
    return { executed: false, reason: `verification unavailable: ${reason}` };
  }

  for (const row of verdict.policyRows ?? []) {
    log(`  ${row.passed ? 'pass' : 'FAIL'}  ${row.id.padEnd(20)} ${row.reason ?? row.name}`);
  }
  for (const unevaluated of verdict.enforcement.unevaluatedPolicies) {
    log(`  n/a   ${unevaluated.policy.padEnd(20)} ${unevaluated.reason}`);
  }

  // 4. Execute or stop.
  if (verdict.decision === 'BLOCK') {
    log(`stopped    ${verdict.reason ?? 'policy refused'}`);
    return { executed: false, reason: verdict.reason ?? 'policy refused', verdict };
  }

  if (verdict.decision === 'REQUIRE_APPROVAL') {
    if (!options.approve) {
      log('stopped    approval required and no approver is wired up');
      return { executed: false, reason: 'approval required, no approver configured', verdict };
    }
    log(`approval   ${verdict.reason ?? 'over the approval threshold'}`);
    if (!(await options.approve(verdict))) {
      log('stopped    the owner declined');
      return { executed: false, reason: 'owner declined', verdict };
    }
  }

  const txHash = await options.execute(options.quote);
  log(`executed   ${txHash}`);
  return { executed: true, reason: verdict.reason ?? 'allowed', txHash, verdict };
}

// --------------------------------------------------------------------------
// Runnable demonstration. Executes nothing: the `execute` step is a stub that
// reports what would have been sent, so this is safe to run against any API.

async function main(): Promise<void> {
  const quote: SwapQuote = {
    // A real Sepolia Universal Router swap, the same fixture the decoder suite
    // pins: tests/fixtures/uniswap-sepolia.json, transaction 0x36ba79b9…3575.
    to: '0x3a9d48ab9751398bbfa63ad67599bb04e4bdf98b',
    data: process.env.QUOTE_CALLDATA ?? '0x',
    value: process.env.QUOTE_VALUE ?? '0',
    chainId: 11155111,
  };

  if (quote.data === '0x') {
    const { readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const fixtures = JSON.parse(
      await readFile(join(here, '../packages/sdk/tests/fixtures/uniswap-sepolia.json'), 'utf8'),
    ) as { transactions: Array<{ commands: string; data: string; value: string; router: string }> };
    const single = fixtures.transactions.find((tx) => tx.commands === '0x10')!;
    quote.to = single.router;
    quote.data = single.data;
    quote.value = single.value;
  }

  const result = await verifyBeforeYouSwap({
    quote,
    execute: async () => {
      console.log('           (dry run: nothing was sent)');
      return '0xdryrun';
    },
    approve: async () => false,
  });

  console.log(`\nresult     executed=${result.executed} — ${result.reason}`);
  process.exit(result.executed || result.verdict ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
