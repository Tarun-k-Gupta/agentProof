import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentProof } from '../../src/core/AgentProof.ts';
import { MemoryStateProvider } from '../../src/state/MemoryStateProvider.ts';
import { SimulatedAccount } from '../../src/testing/SimulatedAccount.ts';
import { ProofRegistry } from '../../src/proofs/ProofRegistry.ts';
import { encodeErc20Transfer, encodeSwapExactIn } from '../../src/testing/calldata.ts';
import { policyHash } from '../../src/core/policy.ts';
import { usdc } from '../../src/utils/units.ts';
import type { Address, ApprovalOutcome, PolicyDocument } from '../../src/core/types.ts';

const ROUTER = '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad' as Address;
const USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238' as Address;
const WETH = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14' as Address;
const ME = '0x00000000000000000000000000000000000000a1' as Address;
const ATTACKER = '0x000000000000000000000000000000000000dead' as Address;

const POLICY: PolicyDocument = {
  version: 'agentproof/v1',
  agent: 'trader.agentproof.eth',
  chainId: 11155111,
  asset: { address: USDC, decimals: 6 },
  policies: {
    maxTransaction: '100000000',
    dailySpend: '500000000',
    approvalThreshold: '100000000',
    minBalance: '10000000',
    allowedContracts: [ROUTER],
    allowedRecipients: [ME],
  },
  enforcement: { hook: '0x0000000000000000000000000000000000000000', account: ME },
};

function setup(overrides: Partial<PolicyDocument> = {}) {
  const policy = { ...POLICY, ...overrides } as PolicyDocument;
  const state = new MemoryStateProvider();
  state.setBalance(ME, USDC, usdc(1000));

  const account = new SimulatedAccount(
    ME,
    {
      asset: USDC,
      maxTransaction: usdc(100),
      dailyLimit: usdc(500),
      minBalance: usdc(10),
      policyHash: policyHash(policy),
      allowedTargets: [ROUTER],
    },
    { balance: usdc(1000) },
  );
  return { policy, state, account };
}

describe('evaluation order', () => {
  test('an allowlist failure short-circuits before any amount is discussed', async () => {
    const { policy, state, account } = setup();
    const proof = await createAgentProof({ policy, state, enforcement: { executor: account } });
    const guarded = await proof.protect();

    // Oversized AND to an unknown recipient. The allowlist runs first, so that
    // is the reason returned — a call to an unrecognised address should never
    // have its amount debated.
    const result = await guarded.execute({
      to: USDC,
      data: encodeErc20Transfer(ATTACKER, usdc(9999)),
      value: 0n,
      chainId: 11155111,
    });

    assert.equal(result.decision, 'BLOCK');
    assert.equal(result.violations[0].policy, 'allowedRecipients');
  });

  test('REQUIRE_APPROVAL never overrides a BLOCK', async () => {
    const { policy, state, account } = setup();
    const proof = await createAgentProof({
      policy,
      state,
      enforcement: { executor: account },
      approver: { request: async (): Promise<ApprovalOutcome> => ({ approved: true, by: 'test' }) },
    });
    const guarded = await proof.protect();

    const result = await guarded.execute({
      to: ROUTER,
      data: encodeSwapExactIn({ recipient: ME, amountIn: usdc(250), tokenIn: USDC, tokenOut: WETH }),
      value: 0n,
      chainId: 11155111,
    });

    assert.equal(result.decision, 'BLOCK', 'an approver must not be able to rescue an over-limit action');
  });
});

describe('human approval', () => {
  test('escalates at the threshold and executes when approved', async () => {
    const { policy, state, account } = setup();
    let asked = 0;
    const proof = await createAgentProof({
      policy,
      state,
      enforcement: { executor: account },
      approver: {
        request: async (): Promise<ApprovalOutcome> => {
          asked += 1;
          return { approved: true, signature: '0xabcd', by: 'test:owner' };
        },
      },
    });
    const guarded = await proof.protect();

    const result = await guarded.execute({
      to: ROUTER,
      data: encodeSwapExactIn({ recipient: ME, amountIn: usdc(100), tokenIn: USDC, tokenOut: WETH }),
      value: 0n,
      chainId: 11155111,
    });

    assert.equal(asked, 1);
    assert.equal(result.decision, 'ALLOW');
    assert.match(result.reason, /approved by test:owner/);
  });

  test('declining blocks the action', async () => {
    const { policy, state, account } = setup();
    const proof = await createAgentProof({
      policy,
      state,
      enforcement: { executor: account },
      approver: { request: async (): Promise<ApprovalOutcome> => ({ approved: false, by: 'test:owner' }) },
    });
    const guarded = await proof.protect();

    const result = await guarded.execute({
      to: ROUTER,
      data: encodeSwapExactIn({ recipient: ME, amountIn: usdc(100), tokenIn: USDC, tokenOut: WETH }),
      value: 0n,
      chainId: 11155111,
    });
    assert.equal(result.decision, 'BLOCK');
  });

  // No reachable human means no approval. Silence is not consent.
  test('blocks when approval is required but no approver is configured', async () => {
    const { policy, state, account } = setup();
    const proof = await createAgentProof({ policy, state, enforcement: { executor: account } });
    const guarded = await proof.protect();

    const result = await guarded.execute({
      to: ROUTER,
      data: encodeSwapExactIn({ recipient: ME, amountIn: usdc(100), tokenIn: USDC, tokenOut: WETH }),
      value: 0n,
      chainId: 11155111,
    });
    assert.equal(result.decision, 'BLOCK');
    assert.match(result.reason, /no approver is configured/);
  });
});

describe('policy hash binding', () => {
  test('refuses to start when the published hash disagrees with the local file', async () => {
    const { policy, state } = setup();
    await assert.rejects(
      createAgentProof({
        policy,
        state,
        identity: {
          resolvePolicyHash: async () => '0x' + 'ff'.repeat(32) as `0x${string}`,
          resolveAccount: async () => ME,
          resolveHook: async () => ME,
          resolveStatus: async () => 'active',
        },
      }),
      /Policy hash published by the ens does not match/,
    );
  });

  test('refuses to start when the agent is suspended', async () => {
    const { policy, state } = setup();
    await assert.rejects(
      createAgentProof({
        policy,
        state,
        identity: {
          resolvePolicyHash: async () => policyHash(policy),
          resolveAccount: async () => ME,
          resolveHook: async () => ME,
          resolveStatus: async () => 'suspended',
        },
      }),
      /marked 'suspended'/,
    );
  });
});

describe('proof surfacing', () => {
  test('reports NOT_RUN rather than assuming success when no artifacts exist', async () => {
    const registry = ProofRegistry.notRun();
    assert.equal(registry.allProven, false);
    assert.deepEqual(
      registry.all().map((r) => r.status),
      ['NOT_RUN', 'NOT_RUN'],
    );
  });

  test('attaches a proof only to the policy that actually decided', async () => {
    const { policy, state, account } = setup();
    const proof = await createAgentProof({
      policy,
      state,
      enforcement: { executor: account },
      proofs: ProofRegistry.from([
        {
          property: 'MAX_TRANSFER',
          status: 'PROVEN',
          tool: 'solc-smtchecker',
          solverTimeMs: 1284,
          artifactPath: 'proofs/MAX_TRANSFER.json',
        },
      ]),
    });
    const guarded = await proof.protect();

    const blocked = await guarded.execute({
      to: ROUTER,
      data: encodeSwapExactIn({ recipient: ME, amountIn: usdc(250), tokenIn: USDC, tokenOut: WETH }),
      value: 0n,
      chainId: 11155111,
    });
    assert.equal(blocked.proof?.property, 'MAX_TRANSFER');
    assert.equal(blocked.proof?.status, 'PROVEN');

    // An allowlist block is not covered by either proof, so no badge is shown.
    const other = await guarded.execute({
      to: USDC,
      data: encodeErc20Transfer(ATTACKER, usdc(5)),
      value: 0n,
      chainId: 11155111,
    });
    assert.equal(other.proof, undefined, 'proof badges must not appear on decisions they do not cover');
  });
});

describe('policy validation', () => {
  test('rejects a daily limit below the per-transaction limit', async () => {
    const { state } = setup();
    await assert.rejects(
      createAgentProof({
        policy: { ...POLICY, policies: { ...POLICY.policies, dailySpend: '50000000' } },
        state,
      }),
      /below maxTransaction/,
    );
  });

  test('rejects an approval threshold nobody could ever reach', async () => {
    const { state } = setup();
    await assert.rejects(
      createAgentProof({
        policy: { ...POLICY, policies: { ...POLICY.policies, approvalThreshold: '500000000' } },
        state,
      }),
      /could ever reach a human/,
    );
  });

  test('rejects an empty allowlist', async () => {
    const { state } = setup();
    await assert.rejects(
      createAgentProof({ policy: { ...POLICY, policies: { ...POLICY.policies, allowedContracts: [] } }, state }),
      /allowedContracts is empty/,
    );
  });
});

describe('on-chain policy hash binding', () => {
  /** Encodes the hook's Config struct the way `config(address)` returns it. */
  function encodeConfig(policyHashValue: string, installed: boolean): `0x${string}` {
    const word = (v: string) => v.replace(/^0x/, '').padStart(64, '0');
    return ('0x' +
      word('0') + // asset
      word('0') + // maxTransaction
      word('0') + // dailyLimit
      word('0') + // minBalance
      word(policyHashValue) + // policyHash
      word(installed ? '1' : '0')) as `0x${string}`;
  }

  const chainReturning = (data: `0x${string}`) => ({
    chainId: 11155111,
    getErc20Balance: async () => 0n,
    call: async () => data,
    getBlockTimestamp: async () => 0,
  });

  test('starts when the hook stores the same hash as the local policy', async () => {
    const { policy, state, account } = setup();
    await assert.doesNotReject(
      createAgentProof({
        policy,
        state,
        enforcement: { executor: account, chain: chainReturning(encodeConfig(policyHash(policy), true)) },
      }),
    );
  });

  test('refuses to start when the hook stores a different hash', async () => {
    const { policy, state, account } = setup();
    await assert.rejects(
      createAgentProof({
        policy,
        state,
        enforcement: { executor: account, chain: chainReturning(encodeConfig('0x' + 'ff'.repeat(32), true)) },
      }),
      /Policy hash published by the hook does not match/,
    );
  });

  // Advice with nothing behind it is worse than no advice, because it reads as
  // enforcement. If the hook is not installed, the SDK does not run.
  test('refuses to run against an account with no hook installed', async () => {
    const { policy, state, account } = setup();
    await assert.rejects(
      createAgentProof({
        policy,
        state,
        enforcement: { executor: account, chain: chainReturning(encodeConfig(policyHash(policy), false)) },
      }),
      /not installed/,
    );
  });
});
