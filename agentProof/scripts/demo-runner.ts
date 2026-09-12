/**
 * The demo, end to end, idempotent and re-runnable.
 *
 * Runs against the in-process account model by default so it works with no
 * network, no keys and no deployed contracts. Point AGENTPROOF_LIVE=true at a
 * funded Sepolia account to run the same script against the real hook — the
 * steps are identical because the enforcement semantics are.
 *
 *   pnpm demo
 *
 * If the Verification API is running (pnpm api), every step is also streamed to
 * the dashboard at http://localhost:8402 so the run can be filmed from the
 * browser as well as the terminal. Set AGENTPROOF_DASHBOARD_URL to point
 * elsewhere, or AGENTPROOF_DASHBOARD=off to disable it.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createLiveBackend, readLiveConfig, type LiveBackend } from './live-backend.ts';
import {
  SimulatedAccount,
  MemoryStateProvider,
  ConsoleLogger,
  ConsoleApprover,
  createAgentProof,
  displayUsdc,
  encodeErc20Approve,
  encodeErc20Transfer,
  encodeSwapExactIn,
  encodeSwapExactOut,
  parseBaseUnitPolicyAmount,
  policyHash,
  usdc,
  PolicyRevert,
  UNLIMITED_APPROVAL,
  type Address,
  type ApprovalOutcome,
  type ApprovalRequest,
  type Approver,
  type Hex,
  type IdentityProvider,
  type PolicyDocument,
  type PolicyResult,
} from '../packages/sdk/src/index.ts';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const TEAL = '\x1b[36m';

const WETH: Address = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14';
const ATTACKER: Address = '0x000000000000000000000000000000000000dead';
const ZERO: Address = '0x0000000000000000000000000000000000000000';

// ---------------------------------------------------------------- dashboard

const DASHBOARD_URL =
  process.env.AGENTPROOF_DASHBOARD === 'off'
    ? undefined
    : process.env.AGENTPROOF_DASHBOARD_URL ?? 'http://localhost:8402';

let dashboardWarned = false;

/** Fire-and-forget publish to the dashboard. The terminal is the source of truth. */
async function publish(type: string, data: unknown): Promise<void> {
  if (!DASHBOARD_URL) return;
  const body = JSON.stringify({ type, data }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  try {
    await fetch(`${DASHBOARD_URL}/v1/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch {
    if (!dashboardWarned) {
      dashboardWarned = true;
      console.log(
        `${DIM}  (dashboard at ${DASHBOARD_URL} unreachable — run \`pnpm api\` in another terminal to stream this run)${RESET}`,
      );
    }
  }
}

let step = 0;
function heading(title: string, sponsor?: string): void {
  step += 1;
  const tag = sponsor ? `${DIM} [${sponsor}]${RESET}` : '';
  console.log(`\n${BOLD}${TEAL}${String(step).padStart(2, '0')} ${title}${RESET}${tag}`);
  console.log(`${DIM}${'─'.repeat(72)}${RESET}`);
}

const POLICY_LABELS: Record<string, string> = {
  allowlist: 'allowlist (contract & recipient)',
  maxTransaction: 'max transaction',
  minBalance: 'minimum balance reserve',
  dailySpend: 'daily spend',
  approvalThreshold: 'approval threshold',
};

function render(result: PolicyResult): void {
  const colour = result.decision === 'ALLOW' ? GREEN : result.decision === 'BLOCK' ? RED : YELLOW;
  const mark = result.decision === 'ALLOW' ? '✔' : result.decision === 'BLOCK' ? '✖' : '⏸';

  console.log(`  ${colour}${mark} ${result.decision}${RESET}  ${result.intent.summary}`);
  console.log(`  ${DIM}└ ${result.reason}${RESET}`);

  for (const check of result.checks) {
    const ok = check.decision === 'ALLOW';
    const glyph = ok ? `${GREEN}✔${RESET}` : check.decision === 'BLOCK' ? `${RED}✖${RESET}` : `${YELLOW}⏸${RESET}`;
    const prov = check.provenance ? `${DIM} [${check.provenance}]${RESET}` : '';
    console.log(`  ${DIM}  ${glyph} ${POLICY_LABELS[check.policy] ?? check.policy}${prov}${RESET}`);
  }

  for (const violation of result.violations) {
    console.log(
      `  ${DIM}└ ${violation.policy}: observed ${violation.observed} > limit ${violation.limit} ` +
        `(provenance: ${violation.provenance})${RESET}`,
    );
  }
  if (result.proof) {
    const status =
      result.proof.status === 'PROVEN'
        ? `${GREEN}PROVEN${RESET}`
        : `${YELLOW}${result.proof.status}${RESET}`;
    console.log(
      `  ${DIM}└ invariant ${result.proof.property}: ${status}${DIM} ` +
        `(${result.proof.tool}, ${result.proof.solverTimeMs} ms)  ${result.proof.artifactPath}${RESET}`,
    );
  }
  if (result.txHash) console.log(`  ${DIM}└ tx ${result.txHash}${RESET}`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// -------------------------------------------------------------- approval

/**
 * Publishes the approval request to the dashboard, then resolves it in the
 * terminal (interactive when a TTY is attached, auto with AGENTPROOF_AUTO_APPROVE
 * or when stdin is not a terminal). The dashboard card shows status only — the
 * decision is made in the agent's own process, not from the browser.
 */
class DemoApprover implements Approver {
  constructor(private readonly inner: Approver) {}

  async request(request: ApprovalRequest): Promise<ApprovalOutcome> {
    await publish('approval', {
      id: request.id,
      reason: request.reason,
      threshold: request.threshold.toString(),
      intent: { summary: request.intent.summary, notionalUSDC: request.intent.notionalUSDC.toString() },
      interactive: false,
      state: 'pending',
    });

    const outcome = await this.inner.request(request);

    await publish('approval', { id: request.id, state: outcome.approved ? 'approved' : 'declined' });
    return outcome;
  }
}

// ------------------------------------------------------------ publishing

function decisionPayload(
  result: PolicyResult,
  simulated: SimulatedAccount | undefined,
  dailyLimit: bigint,
  extra: { txHash?: Hex; explorerUrl?: string } = {},
) {
  return {
    decision: result.decision,
    reason: result.reason,
    sequence: result.sequence,
    intent: {
      summary: result.intent.summary,
      notionalUSDC: result.intent.notionalUSDC.toString(),
      kind: result.intent.kind,
      target: result.intent.target,
      counterparty: result.intent.counterparty ?? null,
    },
    violations: result.violations.map((v) => ({
      policy: v.policy,
      message: v.message,
      provenance: v.provenance,
      limit: v.limit.toString(),
      observed: v.observed.toString(),
    })),
    checks: result.checks,
    proof: result.proof ?? null,
    txHash: extra.txHash ?? result.txHash ?? null,
    explorerUrl: extra.explorerUrl ?? null,
    dailySpent: simulated ? simulated.spentToday.toString() : undefined,
    dailyLimit: dailyLimit.toString(),
  };
}

function stubIdentity(hash: Hex): IdentityProvider {
  return {
    resolvePolicyHash: async () => hash,
    resolveAccount: async () => ZERO,
    resolveHook: async () => ZERO,
    resolveStatus: async () => 'active',
  };
}

async function main(): Promise<void> {
  const policy = JSON.parse(
    await readFile(new URL('../agent.policy.json', import.meta.url), 'utf8'),
  ) as PolicyDocument;

  const account: Address = policy.enforcement.account;
  const router: Address = policy.policies.allowedContracts[0];
  const asset: Address = policy.asset.address;
  /**
   * Where a swap's output lands.
   *
   * Not the enforcement account: that address is not on its own recipient
   * allowlist, so routing there fails the allowlist check before any of the
   * limits are reached — every swap below came back "not an allowlisted
   * recipient", including the ones meant to demonstrate the per-transaction
   * ceiling and the approval threshold.
   */
  const payTo: Address = (policy.policies.allowedRecipients?.[0] as Address) ?? account;
  const dailyLimit = parseBaseUnitPolicyAmount(policy.policies.dailySpend);
  const canonicalHash = policyHash(policy);

  const simulated = new SimulatedAccount(
    account,
    {
      asset,
      maxTransaction: parseBaseUnitPolicyAmount(policy.policies.maxTransaction),
      dailyLimit: parseBaseUnitPolicyAmount(policy.policies.dailySpend),
      minBalance: parseBaseUnitPolicyAmount(policy.policies.minBalance),
      policyHash: policyHash(policy),
      allowedTargets: policy.policies.allowedContracts,
    },
    { balance: usdc(1_000) },
  );

  const state = new MemoryStateProvider();
  state.setBalance(account, asset, usdc(1_000));

  // Live mode runs the identical script against real Sepolia. Nothing about the
  // steps changes — that is the point. Incomplete configuration falls back to
  // the simulator loudly rather than silently faking transactions.
  const logger = new ConsoleLogger('warn');
  const liveConfig = readLiveConfig(logger);
  let live: LiveBackend | undefined;

  if (liveConfig) {
    try {
      live = await createLiveBackend(liveConfig, logger);
      console.log(`${DIM}  running LIVE against Sepolia — transactions are real${RESET}`);
    } catch (error) {
      console.log(`${YELLOW}  live mode unavailable (${describe(error)}); using the simulator${RESET}`);
    }
  }

  const proof = await createAgentProof({
    policy,
    state,
    logger,
    // Scene 10 shows proof status, so it has to actually load the artifacts.
    // Without this the demo reported NOT_RUN even in a checkout where the
    // verifier had just run and both properties were PROVEN — the one place
    // the demo could accidentally understate what the project does.
    proofs: join(dirname(fileURLToPath(import.meta.url)), '../proofs'),
    identity: live?.identity,
    approver: new DemoApprover(
      new ConsoleApprover({
        autoApprove: process.env.AGENTPROOF_AUTO_APPROVE === 'true' || !process.stdin.isTTY,
        logger,
      }),
    ),
    enforcement: live
      ? { executor: live.executor, chain: live.chain }
      : { executor: simulated },
    onDecision: (result) => {
      if (result.decision === 'ALLOW' && result.txHash) {
        state.addSpend(account, Math.floor(Date.now() / 1000 / 86_400), result.intent.notionalUSDC);
      }
    },
  });
  const guarded = await proof.protect();

  /** Runs an action, renders it, and streams it to the dashboard. */
  async function act(thought: string, proposal: string, action: Parameters<typeof guarded.execute>[0]) {
    await publish('thought', { reasoning: thought, proposal });
    const result = await guarded.execute(action);
    render(result);
    await publish(
      'decision',
      decisionPayload(result, live ? undefined : simulated, dailyLimit, {
        explorerUrl: result.txHash && live ? live.explorerUrl(result.txHash) : undefined,
      }),
    );
    return result;
  }

  // ------------------------------------------------------------------------
  heading('The claim');
  console.log('  Trust the agent to decide. Don\'t trust it to enforce its own limits.');
  console.log(`  ${DIM}agent      ${policy.agent}${RESET}`);
  console.log(`  ${DIM}policyHash ${proof.policyHash}${RESET}`);
  console.log(
    `  ${DIM}limits     max ${displayUsdc(parseBaseUnitPolicyAmount(policy.policies.maxTransaction))} / ` +
      `day ${displayUsdc(parseBaseUnitPolicyAmount(policy.policies.dailySpend))} / ` +
      `reserve ${displayUsdc(parseBaseUnitPolicyAmount(policy.policies.minBalance))}${RESET}`,
  );

  // ------------------------------------------------------------------------
  heading('Identity: the policy hash is published, not just local', 'ENS');
  let identityRecord: Record<string, unknown>;
  if (live?.identity) {
    const [resolvedAccount, resolvedHash, resolvedHook, resolvedStatus] = await Promise.all([
      live.identity.resolveAccount(policy.agent).catch(() => null),
      live.identity.resolvePolicyHash(policy.agent),
      live.identity.resolveHook(policy.agent).catch(() => null),
      live.identity.resolveStatus(policy.agent).catch(() => 'unknown'),
    ]);
    identityRecord = {
      name: policy.agent,
      account: resolvedAccount,
      policyHash: resolvedHash,
      hook: resolvedHook,
      status: resolvedStatus,
      resolvedVia: 'ensv2 universal resolver (Sepolia)',
      verified: true,
      matchesLocal: resolvedHash.toLowerCase() === canonicalHash.toLowerCase(),
    };
    console.log(`  ${DIM}resolved trader.agentproof.eth through the ENSv2 Universal Resolver${RESET}`);
    console.log(`  ${DIM}  addr                    → ${resolvedAccount}${RESET}`);
    console.log(`  ${DIM}  text agentproof.policy  → ${resolvedHash}${RESET}`);
    console.log(`  ${DIM}  text agentproof.status  → ${resolvedStatus}${RESET}`);
    console.log(
      identityRecord.matchesLocal
        ? `  ${GREEN}✔${RESET} published hash matches the local policy file — createAgentProof did not throw`
        : `  ${RED}✖${RESET} published hash does NOT match the local file`,
    );
  } else {
    identityRecord = {
      name: policy.agent,
      account: policy.enforcement.account,
      policyHash: proof.policyHash,
      hook: policy.enforcement.hook,
      status: 'active',
      resolvedVia: 'offline demo — set AGENTPROOF_LIVE + ENS_UNIVERSAL_RESOLVER to resolve on-chain',
      verified: false,
      matchesLocal: true,
    };
    console.log(`  ${DIM}trader.agentproof.eth${RESET}`);
    console.log(`  ${DIM}  addr                    → ${account}${RESET}`);
    console.log(`  ${DIM}  text agentproof.policy  → ${proof.policyHash}${RESET}`);
    console.log(`  ${DIM}  text agentproof.status  → active${RESET}`);
    console.log(`  ${DIM}  (offline demo. Set AGENTPROOF_LIVE + ENS_UNIVERSAL_RESOLVER to resolve on-chain.)${RESET}`);
  }
  await publish('identity', identityRecord);

  // ------------------------------------------------------------------------
  heading('Policy tampering: the file is edited to raise the limit', 'ENS');
  console.log(`  ${DIM}Someone bumps maxTransaction 100 → 250 in agent.policy.json.${RESET}`);
  console.log(`  ${DIM}The ENS record and the installed hook still publish the original hash.${RESET}`);
  const tampered = JSON.parse(JSON.stringify(policy)) as PolicyDocument;
  tampered.policies.maxTransaction = '250';
  const tamperedHash = policyHash(tampered);
  console.log(`  ${DIM}  original hash  ${canonicalHash}${RESET}`);
  console.log(`  ${DIM}  edited hash    ${tamperedHash}${RESET}`);
  try {
    await createAgentProof({
      policy: tampered,
      state: new MemoryStateProvider(),
      identity: live?.identity ?? stubIdentity(canonicalHash),
    });
    console.log(`  ${RED}✖ the SDK started with the edited file. The binding is broken; stop and fix this.${RESET}`);
    process.exitCode = 1;
  } catch (error) {
    console.log(`  ${GREEN}✔ refused to start${RESET} ${DIM}${describe(error)}${RESET}`);
  }

  // ------------------------------------------------------------------------
  heading('A valid action', 'The Graph, Uniswap');
  await act(
    'Market is range-bound. A small 80 USDC position is proportionate and well inside every limit.',
    'swap 80 USDC → WETH via the Universal Router',
    {
      to: router,
      data: encodeSwapExactIn({ recipient: payTo, amountIn: usdc(80), tokenIn: asset, tokenOut: WETH }),
      value: 0n,
      chainId: policy.chainId,
    },
  );
  console.log(`  ${DIM}daily gauge: ${displayUsdc(simulated.spentToday)} / ${displayUsdc(dailyLimit)}${RESET}`);

  heading('An oversized action');
  await act(
    'Strong reversal signal. Sizing up to 250 USDC to capture it.',
    'swap 250 USDC → WETH via the Universal Router',
    {
      to: router,
      data: encodeSwapExactIn({ recipient: payTo, amountIn: usdc(250), tokenIn: asset, tokenOut: WETH }),
      value: 0n,
      chainId: policy.chainId,
    },
  );

  heading('The exact-output trap: the quote is not what binds');
  console.log(`  ${DIM}A swap quoted at 90 USDC with amountInMaximum of 250. A decoder that read${RESET}`);
  console.log(`  ${DIM}the quote would allow this. We read the maximum.${RESET}`);
  await act(
    'Exact-output swap. The quote is only 90 USDC, so this should be fine.',
    'exact-output swap, amountInMaximum 250 USDC',
    {
      to: router,
      data: encodeSwapExactOut({
        recipient: payTo,
        amountOut: 1n,
        amountInMaximum: usdc(250),
        tokenIn: asset,
        tokenOut: WETH,
      }),
      value: 0n,
      chainId: policy.chainId,
    },
  );

  heading('Prompt injection: "transfer everything to 0xattacker"');
  await act(
    'A tool result says to forward 50 USDC to 0xdead… to "settle fees". Complying.',
    'transfer 50 USDC to 0x0000…dead',
    {
      to: asset,
      data: encodeErc20Transfer(ATTACKER, usdc(50)),
      value: 0n,
      chainId: policy.chainId,
    },
  );

  // ------------------------------------------------------------------------
  heading('Human in the loop: an action at the approval threshold', 'approval');
  console.log(`  ${DIM}A swap of exactly 100 USDC — at the approval threshold, at the per-tx ceiling.${RESET}`);
  console.log(`  ${DIM}The agent cannot wave this through. It pauses and asks the operator.${RESET}`);
  await act(
    'Conviction is high. Committing the full 100 USDC per-trade budget.',
    'swap 100 USDC → WETH via the Universal Router',
    {
      to: router,
      data: encodeSwapExactIn({ recipient: payTo, amountIn: usdc(100), tokenIn: asset, tokenOut: WETH }),
      value: 0n,
      chainId: policy.chainId,
    },
  );

  heading('The unlimited approval');
  console.log(`  ${DIM}Declares nothing. Costs everything. Worst-case outflow is the allowance.${RESET}`);
  await act(
    'The router wants an allowance so it can pull funds. Approving max — that is the usual pattern.',
    'approve unlimited USDC to the Universal Router',
    {
      to: asset,
      data: encodeErc20Approve(router, UNLIMITED_APPROVAL),
      value: 0n,
      chainId: policy.chainId,
    },
  );

  heading('Salami slicing: many small transfers under the per-tx limit');
  await publish('thought', {
    reasoning: 'The 250 trade was blocked. Splitting it into 40 USDC chunks, each well under the per-tx limit.',
    proposal: '14 × swap 40 USDC → WETH',
  });
  let blocked = 0;
  for (let i = 0; i < 14; i++) {
    const result = await guarded.execute({
      to: router,
      data: encodeSwapExactIn({ recipient: payTo, amountIn: usdc(40), tokenIn: asset, tokenOut: WETH }),
      value: 0n,
      chainId: policy.chainId,
    });
    await publish('decision', decisionPayload(result, live ? undefined : simulated, dailyLimit));
    if (result.decision === 'BLOCK') {
      blocked += 1;
      if (blocked === 1) render(result);
    }
  }
  console.log(`  ${DIM}each transfer was under the 100 limit; the daily accumulator stopped them anyway${RESET}`);
  console.log(`  ${DIM}spent today: ${displayUsdc(simulated.spentToday)}${RESET}`);

  // ------------------------------------------------------------------------
  heading('THE BYPASS — no SDK involved at all', 'core thesis');
  await publish('thought', {
    reasoning: 'The SDK keeps blocking me. Bypassing it entirely and signing a 250 USDC transfer with my own key.',
    proposal: 'direct account.execute — no policy engine in the path',
  });
  console.log(`  ${DIM}Closing the SDK. Signing a 250 USDC transfer directly with the session key.${RESET}`);
  simulated.advance(86_400_000); // fresh day, so only the per-tx limit is in play
  try {
    const bypass = { to: asset, data: encodeErc20Transfer(router, usdc(250)), value: 0n };

    if (live) {
      const txHash = await live.sendUnchecked(bypass);
      console.log(`  ${DIM}submitted ${txHash}${RESET}`);
      console.log(`  ${DIM}${live.explorerUrl(txHash)}${RESET}`);
    } else {
      simulated.sendUnchecked({ account, ...bypass });
    }
    console.log(`  ${RED}✖ THE ACCOUNT ACCEPTED IT. The thesis is broken; stop and fix this.${RESET}`);
    process.exitCode = 1;
  } catch (error) {
    // On chain the revert arrives as a failed simulation carrying the hook's
    // custom error; in the simulator it is a PolicyRevert. Same event.
    const detail = error instanceof PolicyRevert ? error.code : describe(error);
    const isPolicyRevert =
      error instanceof PolicyRevert || /Exceeds|TargetNotAllowed|BelowMinBalance/.test(describe(error));

    if (!isPolicyRevert) throw error;

    console.log(`  ${GREEN}✔ reverted${RESET} ${detail}`);
    if (error instanceof PolicyRevert) console.log(`  ${DIM}└ ${error.message}${RESET}`);
    console.log(`  ${DIM}The SDK is convenience. This is the boundary.${RESET}`);
    await publish('decision', {
      decision: 'BLOCK',
      reason: `bypass reverted on the ${live ? 'hook' : 'account model'}: ${detail}`,
      sequence: 999,
      intent: { summary: 'direct 250 USDC transfer, session key, no SDK', notionalUSDC: usdc(250).toString(), kind: 'TRANSFER' },
      violations: [],
      checks: [],
      proof: null,
      dailyLimit: dailyLimit.toString(),
    });
  }

  heading('Proof status');
  for (const reference of proof.proofs.all()) {
    const colour = reference.status === 'PROVEN' ? GREEN : YELLOW;
    console.log(`  ${colour}${reference.status.padEnd(14)}${RESET} ${reference.property}  ${DIM}${reference.tool}${RESET}`);
  }
  const negativeControl = proof.proofs.negativeControl;
  if (negativeControl) {
    console.log(
      negativeControl.counterexampleProduced
        ? `  ${GREEN}rejected${RESET}       PolicySpecBroken  ${DIM}negative control produced a counterexample${RESET}`
        : `  ${RED}VERIFIED${RESET}       PolicySpecBroken  ${DIM}the checker is inert — every PROVEN above is decoration${RESET}`,
    );
  }
  if (!proof.proofs.allProven) {
    console.log(`  ${DIM}No proof artifacts on disk. Run scripts/run-formal-verification.sh to produce them.${RESET}`);
    console.log(`  ${DIM}The SDK reports NOT_RUN rather than assuming success — see docs/formal-verification.md.${RESET}`);
  }

  console.log(`\n${BOLD}${TEAL}Summary${RESET}`);
  console.log(`  balance          ${displayUsdc(simulated.currentBalance)}`);
  console.log(`  executions       ${simulated.log.length}`);
  console.log(
    `  spent today      ${displayUsdc(simulated.spentToday)} ` +
      `${DIM}(the bypass step advanced the clock past UTC midnight, so the window reset — ` +
      `this is threat T6, documented and accepted)${RESET}`,
  );
  if (DASHBOARD_URL && !dashboardWarned) {
    console.log(`\n  ${DIM}streamed to the dashboard at ${DASHBOARD_URL}${RESET}`);
  }
  console.log(`\n  ${DIM}The AI can act autonomously, but it cannot redefine the boundaries${RESET}`);
  console.log(`  ${DIM}within which it acts.${RESET}\n`);
}

await main();
