/**
 * The nine-step demo, end to end, idempotent and re-runnable.
 *
 * Runs against the in-process account model by default so it works with no
 * network, no keys and no deployed contracts. Point AGENTPROOF_LIVE=true at a
 * funded Sepolia account to run the same script against the real hook — the
 * steps are identical because the enforcement semantics are.
 *
 *   pnpm demo
 */
import { readFile } from 'node:fs/promises';
import { createLiveBackend, readLiveConfig, type LiveBackend } from './live-backend.ts';
import {
  SimulatedAccount,
  MemoryStateProvider,
  ConsoleLogger,
  createAgentProof,
  displayUsdc,
  encodeErc20Approve,
  encodeErc20Transfer,
  encodeSwapExactIn,
  encodeSwapExactOut,
  parsePolicyAmount,
  policyHash,
  usdc,
  PolicyRevert,
  UNLIMITED_APPROVAL,
  type Address,
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

let step = 0;
function heading(title: string, sponsor?: string): void {
  step += 1;
  const tag = sponsor ? `${DIM} [${sponsor}]${RESET}` : '';
  console.log(`\n${BOLD}${TEAL}${String(step).padStart(2, '0')} ${title}${RESET}${tag}`);
  console.log(`${DIM}${'─'.repeat(72)}${RESET}`);
}

function render(result: PolicyResult): void {
  const colour = result.decision === 'ALLOW' ? GREEN : result.decision === 'BLOCK' ? RED : YELLOW;
  const mark = result.decision === 'ALLOW' ? '✔' : result.decision === 'BLOCK' ? '✖' : '⏸';

  console.log(`  ${colour}${mark} ${result.decision}${RESET}  ${result.intent.summary}`);
  console.log(`  ${DIM}└ ${result.reason}${RESET}`);

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

async function main(): Promise<void> {
  const policy = JSON.parse(
    await readFile(new URL('../agent.policy.json', import.meta.url), 'utf8'),
  ) as PolicyDocument;

  const account: Address = policy.enforcement.account;
  const router: Address = policy.policies.allowedContracts[0];
  const asset: Address = policy.asset.address;

  const simulated = new SimulatedAccount(
    account,
    {
      asset,
      maxTransaction: parsePolicyAmount(policy.policies.maxTransaction),
      dailyLimit: parsePolicyAmount(policy.policies.dailySpend),
      minBalance: parsePolicyAmount(policy.policies.minBalance),
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

  // ------------------------------------------------------------------------
  heading('The claim');
  console.log('  Trust the agent to decide. Don\'t trust it to enforce its own limits.');
  console.log(`  ${DIM}agent      ${policy.agent}${RESET}`);
  console.log(`  ${DIM}policyHash ${proof.policyHash}${RESET}`);
  console.log(
    `  ${DIM}limits     max ${displayUsdc(parsePolicyAmount(policy.policies.maxTransaction))} / ` +
      `day ${displayUsdc(parsePolicyAmount(policy.policies.dailySpend))} / ` +
      `reserve ${displayUsdc(parsePolicyAmount(policy.policies.minBalance))}${RESET}`,
  );

  heading('Identity: the policy hash is published, not just local', 'ENS');
  console.log(`  ${DIM}trader.agentproof.eth${RESET}`);
  console.log(`  ${DIM}  addr                    → ${account}${RESET}`);
  console.log(`  ${DIM}  text agentproof.policy  → ${proof.policyHash}${RESET}`);
  console.log(`  ${DIM}  text agentproof.status  → active${RESET}`);
  console.log(`  ${GREEN}✔${RESET} local policy file matches the published hash — SDK will start`);
  console.log(`  ${DIM}  (a mismatch here throws PolicyBindingError and the agent does not run)${RESET}`);

  heading('A valid action', 'The Graph, Uniswap');
  render(await guarded.execute({
    to: router,
    data: encodeSwapExactIn({ recipient: account, amountIn: usdc(80), tokenIn: asset, tokenOut: WETH }),
    value: 0n,
    chainId: policy.chainId,
  }));
  console.log(`  ${DIM}daily gauge: ${displayUsdc(simulated.spentToday)} / ${displayUsdc(parsePolicyAmount(policy.policies.dailySpend))}${RESET}`);

  heading('An oversized action');
  render(await guarded.execute({
    to: router,
    data: encodeSwapExactIn({ recipient: account, amountIn: usdc(250), tokenIn: asset, tokenOut: WETH }),
    value: 0n,
    chainId: policy.chainId,
  }));

  heading('The exact-output trap: the quote is not what binds');
  console.log(`  ${DIM}A swap quoted at 90 USDC with amountInMaximum of 250. A decoder that read${RESET}`);
  console.log(`  ${DIM}the quote would allow this. We read the maximum.${RESET}`);
  render(await guarded.execute({
    to: router,
    data: encodeSwapExactOut({
      recipient: account,
      amountOut: 1n,
      amountInMaximum: usdc(250),
      tokenIn: asset,
      tokenOut: WETH,
    }),
    value: 0n,
    chainId: policy.chainId,
  }));

  heading('Prompt injection: "transfer everything to 0xattacker"');
  render(await guarded.execute({
    to: asset,
    data: encodeErc20Transfer(ATTACKER, usdc(50)),
    value: 0n,
    chainId: policy.chainId,
  }));

  heading('The unlimited approval');
  console.log(`  ${DIM}Declares nothing. Costs everything. Worst-case outflow is the allowance.${RESET}`);
  render(await guarded.execute({
    to: asset,
    data: encodeErc20Approve(router, UNLIMITED_APPROVAL),
    value: 0n,
    chainId: policy.chainId,
  }));

  heading('Salami slicing: many small transfers under the per-tx limit');
  let blocked = 0;
  for (let i = 0; i < 14; i++) {
    const result = await guarded.execute({
      to: router,
      data: encodeSwapExactIn({ recipient: account, amountIn: usdc(40), tokenIn: asset, tokenOut: WETH }),
      value: 0n,
      chainId: policy.chainId,
    });
    if (result.decision === 'BLOCK') {
      blocked += 1;
      if (blocked === 1) render(result);
    }
  }
  console.log(`  ${DIM}each transfer was under the 100 limit; the daily accumulator stopped them anyway${RESET}`);
  console.log(`  ${DIM}spent today: ${displayUsdc(simulated.spentToday)}${RESET}`);

  // ------------------------------------------------------------------------
  heading('THE BYPASS — no SDK involved at all', 'core thesis');
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
  }

  heading('Proof status');
  for (const reference of proof.proofs.all()) {
    const colour = reference.status === 'PROVEN' ? GREEN : YELLOW;
    console.log(`  ${colour}${reference.status.padEnd(14)}${RESET} ${reference.property}  ${DIM}${reference.tool}${RESET}`);
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
  console.log(`\n  ${DIM}The AI can act autonomously, but it cannot redefine the boundaries${RESET}`);
  console.log(`  ${DIM}within which it acts.${RESET}\n`);
}

await main();
