import {
  ConsoleLogger,
  MemoryStateProvider,
  SimulatedAccount,
  createAgentProof,
  displayUsdc,
  parseBaseUnitPolicyAmount,
  usdc,
  type Action,
  type Address,
  type PolicyDocument,
  type PolicyResult,
} from '@agentproof/sdk';
import { X402Client, type PaymentRequirements, type PaymentSigner } from '@agentproof/x402-client';

/**
 * The researcher.
 *
 * It needs data it has to pay for, and it pays per query over x402 on Hedera.
 * The point it makes is not that an agent can pay — plenty of demos show that.
 * It is that the payment goes through the same policy engine as a swap: the
 * same maxTransaction, the same daily accumulator, the same allowlist.
 *
 * And the service it pays is the AgentProof verification API, so the loop
 * closes: an agent pays, under AgentProof policy, for an AgentProof
 * verification, and the payment itself is policy-checked before it is signed.
 */

export interface ResearcherOptions {
  policy: PolicyDocument;
  serviceUrl: string;
  signer: PaymentSigner;
  facilitator: Address;
  queries: readonly string[];
  onDecision?: (result: PolicyResult) => void;
}

export async function runResearcher(options: ResearcherOptions) {
  const logger = new ConsoleLogger('info');
  const policy = options.policy;

  const account = new SimulatedAccount(
    policy.enforcement.account as Address,
    {
      asset: policy.asset.address,
      maxTransaction: parseBaseUnitPolicyAmount(policy.policies.maxTransaction),
      dailyLimit: parseBaseUnitPolicyAmount(policy.policies.dailySpend),
      minBalance: parseBaseUnitPolicyAmount(policy.policies.minBalance),
      policyHash: '0x00',
      allowedTargets: [...policy.policies.allowedContracts, options.facilitator],
    },
    { balance: usdc(1_000) },
  );

  const state = new MemoryStateProvider();
  state.setBalance(policy.enforcement.account, policy.asset.address, usdc(1_000));

  const proof = await createAgentProof({ policy, state, logger, enforcement: { executor: account } });
  const protectedAccount = await proof.protect();

  const results: PolicyResult[] = [];

  const client = new X402Client({
    http: { postJson: async () => ({}) as never, getJson: async () => ({}) as never },
    signer: options.signer,
    logger,
    maxPricePerCall: '0.05',
    policyContext: {
      facilitator: options.facilitator,
      token: policy.asset.address,
      chainId: policy.chainId,
    },
    // The gate. A 402 challenge is a request for money from a party the agent
    // has never met, arriving mid-task. It goes through policy before a key
    // touches it.
    authorise: async (action: Action, requirements: PaymentRequirements) => {
      const decision = await protectedAccount.check(action);
      results.push(decision);
      options.onDecision?.(decision);
      logger.log(decision.decision === 'ALLOW' ? 'info' : 'warn', `payment ${decision.decision}`, {
        amount: requirements.amount,
        reason: decision.reason,
      });
      return decision.decision === 'ALLOW';
    },
  });

  const answers: unknown[] = [];
  for (const query of options.queries) {
    try {
      const response = await client.fetchPaid<unknown>(`${options.serviceUrl}/v1/verify`, {
        agent: policy.agent,
        action: {
          to: policy.enforcement.account,
          data: '0x',
          value: '0',
          chainId: policy.chainId,
          metadata: { query },
        },
      });
      answers.push(response.data);
      logger.log('info', 'paid query completed', { paid: response.paid, transactionId: response.transactionId });
    } catch (error) {
      logger.log('warn', 'query abandoned', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  logger.log('info', 'researcher finished', {
    queries: options.queries.length,
    spentToday: displayUsdc(account.spentToday),
  });

  return { answers, results, account };
}

/**
 * Local signer used by the demo when no Hedera credentials are present.
 * Produces a well-formed payload that the facilitator will reject, which is the
 * correct behaviour: a demo that fakes a settlement is a demo that proves
 * nothing about settlement.
 */
export function stubSigner(accountId = '0.0.0'): PaymentSigner {
  return {
    accountId: () => accountId,
    async signPayment(requirements) {
      return Buffer.from(
        JSON.stringify({
          x402Version: 1,
          scheme: requirements.scheme,
          network: requirements.network,
          payload: { unsigned: true, note: 'stub signer — no Hedera credentials configured' },
        }),
      ).toString('base64');
    },
  };
}
