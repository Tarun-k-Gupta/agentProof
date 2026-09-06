import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PolicyEngine } from '../../src/core/PolicyEngine.ts';
import { createDefaultRegistry } from '../../src/decode/index.ts';
import { DailySpendPolicy, MaxTransactionPolicy } from '../../src/policies/index.ts';
import { PolicyRevert, SimulatedAccount } from '../../src/testing/SimulatedAccount.ts';
import { encodeErc20Transfer } from '../../src/testing/calldata.ts';
import { usdc } from '../../src/utils/units.ts';
import type { Address, NormalizedIntent, PolicyState } from '../../src/core/types.ts';

/**
 * The differential suite.
 *
 * The off-chain engine (L1) and the on-chain enforcement semantics (L2) are two
 * independent implementations of the same arithmetic. A safety product where
 * those two disagree has a gap exactly the width of the disagreement: an action
 * the SDK waves through and the chain reverts is a broken agent, and an action
 * the SDK blocks but the chain would have allowed is a limit nobody is really
 * enforcing.
 *
 * So we fuzz them against each other and assert they never diverge.
 */

const USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238' as Address;
const RECIPIENT = '0x00000000000000000000000000000000000000b2' as Address;
const ME = '0x00000000000000000000000000000000000000a1' as Address;

const MAX_TX = usdc(100);
const DAILY = usdc(500);

function makeEngine() {
  return new PolicyEngine({
    decoders: createDefaultRegistry(),
    decoderContext: { account: ME, trackedAsset: USDC, decimals: 6 },
    policies: [new MaxTransactionPolicy(MAX_TX), new DailySpendPolicy(DAILY)],
  });
}

function makeAccount() {
  return new SimulatedAccount(
    ME,
    {
      asset: USDC,
      maxTransaction: MAX_TX,
      dailyLimit: DAILY,
      minBalance: 0n,
      policyHash: '0x00',
      allowedTargets: [USDC, RECIPIENT],
    },
    { balance: usdc(1_000_000) },
  );
}

/** Deterministic PRNG so a failure is reproducible from the seed alone. */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('L1 engine vs L2 enforcement', () => {
  test('agree on ALLOW/BLOCK across 4000 random spend sequences', () => {
    const engine = makeEngine();
    let disagreements = 0;
    let allowed = 0;
    let blocked = 0;

    for (let seed = 1; seed <= 40; seed++) {
      const random = makeRandom(seed);
      const account = makeAccount();
      let engineSpend = 0n;

      for (let i = 0; i < 100; i++) {
        // Bias amounts around the boundaries, where bugs live.
        const roll = random();
        const amount =
          roll < 0.25
            ? MAX_TX
            : roll < 0.45
              ? MAX_TX + 1n
              : BigInt(Math.floor(random() * 130 * 1e6));

        const action = {
          to: USDC,
          data: encodeErc20Transfer(RECIPIENT, amount),
          value: 0n,
          chainId: 11155111,
        } as const;

        const state: PolicyState = {
          account: ME,
          dayUtc: account.today(),
          dailySpend: engineSpend,
          balance: usdc(1_000_000),
          asset: USDC,
          now: Date.now(),
        };

        const l1 = engine.verify(action, state);

        let l2Allowed = true;
        try {
          account.sendUnchecked({ account: ME, to: USDC, data: action.data, value: 0n });
        } catch (error) {
          if (!(error instanceof PolicyRevert)) throw error;
          l2Allowed = false;
        }

        if ((l1.decision === 'ALLOW') !== l2Allowed) {
          disagreements += 1;
          assert.fail(
            `seed ${seed} step ${i}: L1 said ${l1.decision} but L2 ${l2Allowed ? 'allowed' : 'reverted'} ` +
              `for amount ${amount}`,
          );
        }

        if (l1.decision === 'ALLOW') {
          engineSpend += amount;
          allowed += 1;
        } else {
          blocked += 1;
        }
      }
    }

    assert.equal(disagreements, 0);
    // Guard against a vacuous pass: if the fuzzer never blocked anything, the
    // test proved nothing about the boundary.
    assert.ok(allowed > 100, `expected meaningful ALLOW coverage, saw ${allowed}`);
    assert.ok(blocked > 100, `expected meaningful BLOCK coverage, saw ${blocked}`);
  });

  test('a reverted spend leaves the accumulator untouched', () => {
    const account = makeAccount();
    account.sendUnchecked({ account: ME, to: USDC, data: encodeErc20Transfer(RECIPIENT, usdc(60)), value: 0n });
    const before = account.spentToday;
    const balanceBefore = account.currentBalance;

    assert.throws(
      () => account.sendUnchecked({ account: ME, to: USDC, data: encodeErc20Transfer(RECIPIENT, usdc(200)), value: 0n }),
      PolicyRevert,
    );

    assert.equal(account.spentToday, before, 'a rejected spend must not move the accumulator');
    assert.equal(account.currentBalance, balanceBefore, 'a rejected spend must not move funds');
  });

  test('the daily window resets at the UTC boundary', () => {
    const account = makeAccount();
    for (let i = 0; i < 5; i++) {
      account.sendUnchecked({ account: ME, to: USDC, data: encodeErc20Transfer(RECIPIENT, usdc(100)), value: 0n });
    }
    assert.equal(account.spentToday, DAILY);

    assert.throws(
      () => account.sendUnchecked({ account: ME, to: USDC, data: encodeErc20Transfer(RECIPIENT, usdc(1)), value: 0n }),
      PolicyRevert,
    );

    account.advance(86_400_000);
    assert.equal(account.spentToday, 0n, 'threat T6: the bucket resets, by design and by documentation');
    account.sendUnchecked({ account: ME, to: USDC, data: encodeErc20Transfer(RECIPIENT, usdc(100)), value: 0n });
    assert.equal(account.spentToday, usdc(100));
  });
});
