import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  AllowlistPolicy,
  ApprovalThresholdPolicy,
  DailySpendPolicy,
  MaxTransactionPolicy,
  MinBalancePolicy,
} from '../../src/policies/index.ts';
import { usdc, UNBOUNDED } from '../../src/utils/units.ts';
import { addressSet } from '../../src/utils/hex.ts';
import type { Address, NormalizedIntent, PolicyState } from '../../src/core/types.ts';

const ROUTER = '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad' as Address;
const USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238' as Address;
const ME = '0x00000000000000000000000000000000000000a1' as Address;
const ATTACKER = '0x000000000000000000000000000000000000dead' as Address;

function intent(overrides: Partial<NormalizedIntent> = {}): NormalizedIntent {
  return {
    kind: 'SWAP',
    target: ROUTER,
    selector: '0x24856bc3',
    nativeValue: 0n,
    outflow: [{ asset: USDC, amount: usdc(50), provenance: 'DECODED' }],
    counterparty: ME,
    notionalUSDC: usdc(50),
    summary: 'test intent',
    raw: { to: ROUTER, data: '0x24856bc3', value: 0n, chainId: 11155111 },
    ...overrides,
  };
}

const state: PolicyState = {
  account: ME,
  dayUtc: 20000,
  dailySpend: 0n,
  balance: usdc(1000),
  asset: USDC,
  now: Date.now(),
};

describe('MaxTransactionPolicy', () => {
  const policy = new MaxTransactionPolicy(usdc(100));

  test('allows an amount below the limit', () => {
    assert.equal(policy.evaluate(intent({ notionalUSDC: usdc(99) }), state).decision, 'ALLOW');
  });

  // The boundary is the bug people actually ship. An amount exactly equal to
  // the limit is permitted: the limit is a ceiling, not an exclusive bound, and
  // the Solidity uses the same comparison.
  test('allows an amount exactly at the limit', () => {
    assert.equal(policy.evaluate(intent({ notionalUSDC: usdc(100) }), state).decision, 'ALLOW');
  });

  test('blocks one base unit over the limit', () => {
    const result = policy.evaluate(intent({ notionalUSDC: usdc(100) + 1n }), state);
    assert.equal(result.decision, 'BLOCK');
    assert.equal(result.violation?.policy, 'maxTransaction');
  });

  test('blocks an unbounded outflow', () => {
    assert.equal(policy.evaluate(intent({ notionalUSDC: UNBOUNDED }), state).decision, 'BLOCK');
  });
});

describe('DailySpendPolicy', () => {
  const policy = new DailySpendPolicy(usdc(500));

  test('allows a spend that lands exactly on the daily limit', () => {
    const result = policy.evaluate(intent({ notionalUSDC: usdc(100) }), { ...state, dailySpend: usdc(400) });
    assert.equal(result.decision, 'ALLOW');
  });

  test('blocks a spend one unit over the daily limit', () => {
    const result = policy.evaluate(intent({ notionalUSDC: usdc(100) + 1n }), { ...state, dailySpend: usdc(400) });
    assert.equal(result.decision, 'BLOCK');
    assert.equal(result.violation?.observed, usdc(500) + 1n);
  });

  // Threat T5: each individual transfer is well under the per-transaction
  // limit, and the cumulative accumulator is the only thing that stops them.
  test('defeats salami slicing', () => {
    let spent = 0n;
    let blockedAt = -1;
    for (let i = 0; i < 20; i++) {
      const result = policy.evaluate(intent({ notionalUSDC: usdc(40) }), { ...state, dailySpend: spent });
      if (result.decision === 'BLOCK') {
        blockedAt = i;
        break;
      }
      spent += usdc(40);
    }
    assert.equal(blockedAt, 12, 'should block the 13th 40-USDC transfer (12 * 40 = 480, 13th would be 520)');
    assert.ok(spent <= usdc(500));
  });
});

describe('AllowlistPolicy', () => {
  const policy = new AllowlistPolicy(addressSet([ROUTER, USDC]), addressSet([ME]));

  test('allows a call to an allowlisted contract with an allowlisted counterparty', () => {
    assert.equal(policy.evaluate(intent(), state).decision, 'ALLOW');
  });

  test('blocks a call to an unknown contract', () => {
    assert.equal(policy.evaluate(intent({ target: ATTACKER }), state).decision, 'BLOCK');
  });

  // Threat T2: the contract is fine, the destination is not.
  test('blocks a value-moving call to an unknown counterparty', () => {
    const result = policy.evaluate(
      intent({ kind: 'TRANSFER', target: USDC, counterparty: ATTACKER }),
      state,
    );
    assert.equal(result.decision, 'BLOCK');
    assert.equal(result.violation?.policy, 'allowedRecipients');
  });

  test('blocks undecodable calldata by default', () => {
    const result = policy.evaluate(intent({ kind: 'UNKNOWN', notionalUSDC: UNBOUNDED }), state);
    assert.equal(result.decision, 'BLOCK');
    assert.equal(result.violation?.policy, 'unknownSelector');
  });

  test('permits undecodable calldata only when explicitly opted in', () => {
    const permissive = new AllowlistPolicy(addressSet([ROUTER, USDC]), addressSet([ME]), {
      allowUnknownSelectors: true,
    });
    assert.equal(permissive.evaluate(intent({ kind: 'UNKNOWN' }), state).decision, 'ALLOW');
  });
});

describe('MinBalancePolicy', () => {
  const policy = new MinBalancePolicy(usdc(10));

  test('allows a spend that leaves exactly the reserve', () => {
    const result = policy.evaluate(intent({ notionalUSDC: usdc(90) }), { ...state, balance: usdc(100) });
    assert.equal(result.decision, 'ALLOW');
  });

  test('blocks a spend that breaches the reserve', () => {
    const result = policy.evaluate(intent({ notionalUSDC: usdc(95) }), { ...state, balance: usdc(100) });
    assert.equal(result.decision, 'BLOCK');
  });
});

describe('ApprovalThresholdPolicy', () => {
  const policy = new ApprovalThresholdPolicy(usdc(100));

  test('passes below the threshold', () => {
    assert.equal(policy.evaluate(intent({ notionalUSDC: usdc(99) }), state).decision, 'ALLOW');
  });

  test('escalates at the threshold', () => {
    assert.equal(policy.evaluate(intent({ notionalUSDC: usdc(100) }), state).decision, 'REQUIRE_APPROVAL');
  });
});
