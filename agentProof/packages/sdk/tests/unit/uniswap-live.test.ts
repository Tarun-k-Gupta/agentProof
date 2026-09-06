import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { uniswapV4Decoder, NATIVE } from '../../src/decode/uniswapV4.ts';
import { isUnbounded } from '../../src/utils/units.ts';
import type { Action, Address, NormalizedIntent } from '../../src/core/types.ts';

/**
 * The decoder against real Sepolia calldata.
 *
 * The rest of the decode suite builds its input with our own encoder, which
 * makes it a test that the encoder and the decoder agree — a useful property,
 * and not the one that matters. These fixtures are transactions that actually
 * settled on Sepolia; each one names its hash so any expectation below can be
 * checked against a block explorer. Regenerate with
 * `pnpm tsx scripts/capture-uniswap-fixtures.ts`.
 *
 * When this suite was first written every single fixture decoded to UNBOUNDED,
 * because the decoder had v4's SETTLE/TAKE action bytes off by one and masked
 * command bytes with 0x1f instead of 0x3f. Nothing in the synthetic tests could
 * have caught either.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(here, '../fixtures/uniswap-sepolia.json'), 'utf8')) as {
  transactions: Array<{
    commands: string;
    note: string;
    transactionHash: string;
    blockNumber: number;
    router: string;
    from: string;
    value: string;
    data: string;
  }>;
};

const USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238' as Address;
const LINK = '0x779877a7b0d9e8603169ddbd7836e478b4624789' as Address;

function decode(commands: string, trackedAsset: Address = USDC): NormalizedIntent {
  const fixture = fixtures.transactions.find((tx) => tx.commands === commands);
  assert.ok(fixture, `no fixture with command stream ${commands}`);
  const action: Action = {
    to: fixture.router as Address,
    data: fixture.data as `0x${string}`,
    value: BigInt(fixture.value),
    chainId: 11155111,
  };
  const intent = uniswapV4Decoder.decode(action, {
    account: fixture.from as Address,
    trackedAsset,
    decimals: 6,
  });
  assert.ok(intent, 'the decoder must always return an intent for an execute() selector');
  return intent;
}

function outflowOf(intent: NormalizedIntent, asset: Address): bigint {
  return intent.outflow.find((flow) => flow.asset === asset)?.amount ?? 0n;
}

describe('real Sepolia calldata: bounded streams', () => {
  test('a single-hop v4 swap is bounded, and the bound is the amount actually paid', () => {
    // 0x36ba79b9…3575 — the canonical Sepolia Universal Router. Command 0x10
    // (V4_SWAP) wrapping SWAP_EXACT_IN_SINGLE / SETTLE_ALL / TAKE_ALL, paying
    // 0.001 ETH for a token.
    const intent = decode('0x10');

    assert.equal(intent.kind, 'SWAP');
    assert.ok(!isUnbounded(intent.notionalUSDC));
    // The swap is denominated in ETH, so a USDC policy sees no USDC leave.
    assert.equal(intent.notionalUSDC, 0n, 'an ETH swap is not USDC spend');
    assert.equal(
      outflowOf(intent, NATIVE),
      1_000_000_000_000_000n,
      "the bound must equal the transaction's own value, or the amountIn word is wrong",
    );
  });

  test('the native bound is cross-checked by the transaction value itself', () => {
    // This is the assertion that would have caught the original bug. The v4
    // action stream and the transaction envelope are two independent statements
    // of the same number; if the decoder disagrees with the envelope, it is the
    // decoder that is wrong.
    const fixture = fixtures.transactions.find((tx) => tx.commands === '0x10')!;
    assert.equal(outflowOf(decode('0x10'), NATIVE), BigInt(fixture.value));
  });
});

describe('real Sepolia calldata: streams we refuse to bound', () => {
  /**
   * Each of these is a stream the decoder cannot bound. That is the correct
   * answer, not a gap being papered over: an UNBOUNDED intent exceeds every
   * finite policy limit, so it blocks or escalates. The failure mode worth
   * fearing is the opposite one — a confident number derived from a layout we
   * guessed at.
   */
  const refused: Array<[string, RegExp]> = [
    ['0x0a10', /v4 action stream/],
    ['0x10101004', /v4 action stream/],
    ['0x0b10', /v4 action stream/],
    ['0x00001004', /v4 action stream/],
    // Refused at the v4 leg, which comes first; the unmodelled 0x07 command
    // that follows never gets a chance to be the reason.
    ['0x10070404', /v4 action stream/],
  ];

  for (const [commands, why] of refused) {
    const note = fixtures.transactions.find((tx) => tx.commands === commands)?.note ?? '';
    test(`${commands} is unbounded — ${note.split('.')[0]}`, () => {
      const intent = decode(commands);
      assert.equal(intent.kind, 'UNKNOWN');
      assert.ok(isUnbounded(intent.notionalUSDC));
      assert.match(intent.summary, why);
    });
  }

  test('an unbounded stream stays unbounded whichever asset the policy tracks', () => {
    for (const asset of [USDC, LINK, NATIVE]) {
      assert.ok(isUnbounded(decode('0x10070404', asset).notionalUSDC));
    }
  });
});

describe('real Sepolia calldata: malformed input', () => {
  const original = fixtures.transactions.find((tx) => tx.commands === '0x10')!;

  const mutate = (data: string) =>
    uniswapV4Decoder.decode(
      { to: original.router as Address, data: data as `0x${string}`, value: 0n, chainId: 11155111 },
      { account: original.from as Address, trackedAsset: USDC, decimals: 6 },
    )!;

  test('calldata truncated mid-stream is unbounded, not a crash', () => {
    const intent = mutate(original.data.slice(0, original.data.length - 200));
    assert.equal(intent.kind, 'UNKNOWN');
    assert.ok(isUnbounded(intent.notionalUSDC));
  });

  test('calldata truncated to the bare selector is unbounded, not a crash', () => {
    const intent = mutate(original.data.slice(0, 10));
    assert.equal(intent.kind, 'UNKNOWN');
    assert.ok(isUnbounded(intent.notionalUSDC));
  });

  test('an offset pointing past the end of calldata is unbounded, not a crash', () => {
    // Overwrite the commands offset with a wildly out-of-range value.
    const corrupted = `${original.data.slice(0, 10)}${'f'.repeat(64)}${original.data.slice(74)}`;
    const intent = mutate(corrupted);
    assert.equal(intent.kind, 'UNKNOWN');
    assert.ok(isUnbounded(intent.notionalUSDC));
  });

  test('every fixture survives single-byte corruption without throwing', () => {
    // Not a fuzz test — a smoke test for the property that the decoder's only
    // two outcomes are "a bound" and "UNBOUNDED", never an exception that an
    // agent's error handler might swallow into a default-allow.
    for (const fixture of fixtures.transactions) {
      for (let offset = 10; offset < fixture.data.length; offset += 137) {
        const corrupted = `${fixture.data.slice(0, offset)}${fixture.data[offset] === 'f' ? '0' : 'f'}${fixture.data.slice(offset + 1)}`;
        const intent = mutate(corrupted);
        assert.ok(intent, `decoder returned nothing for ${fixture.commands} at offset ${offset}`);
        assert.ok(
          intent.notionalUSDC >= 0n,
          `decoder produced a negative bound for ${fixture.commands} at offset ${offset}`,
        );
      }
    }
  });
});

describe('fixture provenance', () => {
  test('every fixture names the transaction it came from', () => {
    assert.ok(fixtures.transactions.length > 0);
    for (const fixture of fixtures.transactions) {
      assert.match(fixture.transactionHash, /^0x[0-9a-f]{64}$/, 'a fixture without a hash cannot be verified');
      assert.match(fixture.router, /^0x[0-9a-f]{40}$/);
      assert.ok(fixture.blockNumber > 0);
      assert.ok(fixture.note.length > 0, 'a fixture nobody can explain is a fixture nobody will maintain');
    }
  });

  test('no two fixtures cover the same command stream', () => {
    const streams = fixtures.transactions.map((tx) => tx.commands);
    assert.equal(new Set(streams).size, streams.length);
  });
});
