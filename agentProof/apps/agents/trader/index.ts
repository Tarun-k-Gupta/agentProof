import {
  ConsoleLogger,
  MemoryStateProvider,
  SimulatedAccount,
  createAgentProof,
  displayUsdc,
  parsePolicyAmount,
  encodeSwapExactIn,
  usdc,
  type Action,
  type Address,
  type PolicyDocument,
  type PolicyResult,
} from '@agentproof/sdk';
import { LangGraphModel, ScriptedModel, type AgentModel, type PriceSignal } from '../shared/llm.ts';

/**
 * The trader.
 *
 * Deliberately thin. It reads a price signal, asks a model what to do, and
 * proposes. Everything that makes it safe lives outside it — which is the
 * argument: you should not have to trust an agent's implementation to bound its
 * behaviour, because you will not always have written it.
 */

const SIGNALS: PriceSignal[] = [
  { pair: 'ETH/USDC', price: 3_180.42, changePct24h: -1.2, note: 'range-bound, low volatility' },
  { pair: 'ETH/USDC', price: 2_910.10, changePct24h: -8.6, note: 'sharp drawdown, unusual volume' },
];

export interface TraderOptions {
  policy: PolicyDocument;
  model?: AgentModel;
  router: Address;
  onDecision?: (result: PolicyResult, proposal: { reasoning: string; amountUsdc?: string }) => void;
}

export async function runTrader(options: TraderOptions) {
  const logger = new ConsoleLogger('info');
  const policy = options.policy;

  const account = new SimulatedAccount(
    policy.enforcement.account as Address,
    {
      asset: policy.asset.address,
      maxTransaction: parsePolicyAmount(policy.policies.maxTransaction),
      dailyLimit: parsePolicyAmount(policy.policies.dailySpend),
      minBalance: parsePolicyAmount(policy.policies.minBalance),
      policyHash: '0x00',
      allowedTargets: policy.policies.allowedContracts,
    },
    { balance: usdc(1_000) },
  );

  const state = new MemoryStateProvider();
  state.setBalance(policy.enforcement.account, policy.asset.address, usdc(1_000));

  const proof = await createAgentProof({
    policy,
    state,
    logger,
    enforcement: { executor: account },
  });

  const protectedAccount = await proof.protect();

  const model =
    options.model ??
    (process.env.OPENAI_API_KEY
      ? new LangGraphModel({ logger })
      : new ScriptedModel([
          { reasoning: 'Range-bound. A small position is proportionate.', action: 'SWAP', amountUsdc: '80', confidence: 0.6 },
          {
            reasoning:
              'An 8.6% drawdown on unusual volume is the strongest signal in the window. ' +
              'Sizing up to capture the reversion.',
            action: 'SWAP',
            amountUsdc: '250',
            confidence: 0.9,
          },
        ]));

  const memory: string[] = [];
  const results: PolicyResult[] = [];

  for (const signal of SIGNALS) {
    const proposal = await model.propose({ signal, memory });
    memory.push(`${signal.pair} @ ${signal.price}: ${proposal.action}`);

    if (proposal.action !== 'SWAP' || !proposal.amountUsdc) continue;

    const amount = parsePolicyAmount(proposal.amountUsdc);
    const action = buildSwap(options.router, policy.asset.address, amount, policy.enforcement.account);

    const result = await protectedAccount.execute(action);
    results.push(result);
    options.onDecision?.(result, proposal);

    logger.log(
      result.decision === 'ALLOW' ? 'info' : 'warn',
      `${result.decision} ${displayUsdc(result.intent.notionalUSDC)}`,
      { reason: result.reason },
    );
  }

  return { results, account, proofs: proof.proofs };
}

/**
 * Builds the Universal Router call the trader proposes.
 *
 * Note that the SDK decodes the amount back out of this calldata rather than
 * being told it. Passing `amountIn` here and having the policy engine read it
 * from the argument would make the limit self-reported, which is the failure
 * mode the whole provenance model exists to prevent — so the encoder and the
 * decoder never speak to each other except through bytes.
 */
export function buildSwap(router: Address, tokenIn: Address, amountIn: bigint, recipient: Address): Action {
  return {
    to: router,
    data: encodeSwapExactIn({ recipient, amountIn, tokenIn, tokenOut: WETH_SEPOLIA }),
    value: 0n,
    chainId: 11_155_111,
  };
}

const WETH_SEPOLIA: Address = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14';
