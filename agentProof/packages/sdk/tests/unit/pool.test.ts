import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { UniswapPoolProvider } from '../../src/state/UniswapPoolProvider.ts';
import { PoolLiquidityPolicy } from '../../src/policies/index.ts';
import type { Address, NormalizedIntent, PolicyState } from '../../src/core/types.ts';
import type { HttpClient } from '../../src/ports/index.ts';
import { usdc } from '../../src/utils/units.ts';

/**
 * The cross-protocol read: a second, public subgraph, feeding a policy.
 *
 * The property under test is the three-valued handling of pool state. "There
 * is no pool" and "we could not ask" have to produce different outcomes, or an
 * outage at The Graph starts blocking every swap — and the fix somebody
 * reaches for under that pressure is to pass on failure, which is worse.
 */

const USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238' as Address;
const WETH = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14' as Address;

function subgraph(pools: Array<{ id: string; feeTier: string; totalValueLockedUSD: string; volumeUSD: string }> | Error): HttpClient {
  return {
    async postJson<T>(): Promise<T> {
      if (pools instanceof Error) throw pools;
      return { data: { pools } } as T;
    },
    async getJson<T>(): Promise<T> {
      throw new Error('not used');
    },
  };
}

const swap: NormalizedIntent = {
  kind: 'SWAP',
  target: WETH,
  selector: '0x3593564c',
  nativeValue: 0n,
  outflow: [{ asset: USDC, amount: usdc(80), provenance: 'DECODED' }],
  counterparty: WETH,
  notionalUSDC: usdc(80),
  summary: 'Swap up to 80.00 USDC via Universal Router',
  raw: { to: WETH, data: '0x', value: 0n, chainId: 11155111 },
};

const baseState = (pool: PolicyState['pool']): PolicyState => ({
  account: USDC,
  dayUtc: 20_000,
  dailySpend: 0n,
  balance: usdc(1000),
  asset: USDC,
  now: Date.now(),
  pool,
});

describe('UniswapPoolProvider', () => {
  test('returns the deepest pool for a pair', async () => {
    const provider = new UniswapPoolProvider({
      endpoint: 'https://example.invalid',
      http: subgraph([
        { id: '0xdeep', feeTier: '3000', totalValueLockedUSD: '412000.5', volumeUSD: '91000' },
        { id: '0xthin', feeTier: '500', totalValueLockedUSD: '12', volumeUSD: '0' },
      ]),
      ttlMs: 0,
    });

    const pool = await provider.deepestPool(USDC, WETH);
    assert.equal(pool?.id, '0xdeep');
    assert.equal(pool?.totalValueLockedUSD, 412_000.5);
    assert.equal(pool?.feeTier, 3000);
  });

  test('an empty result is null, not an error', async () => {
    const provider = new UniswapPoolProvider({ endpoint: 'https://example.invalid', http: subgraph([]), ttlMs: 0 });
    assert.equal(await provider.deepestPool(USDC, WETH), null);
  });

  test('an unreachable subgraph throws rather than reporting "no pool"', async () => {
    const provider = new UniswapPoolProvider({
      endpoint: 'https://example.invalid',
      http: subgraph(new Error('gateway timeout')),
      ttlMs: 0,
    });
    await assert.rejects(() => provider.deepestPool(USDC, WETH), /gateway timeout/);
  });

  test('GraphQL errors throw rather than reporting "no pool"', async () => {
    const http: HttpClient = {
      async postJson<T>(): Promise<T> {
        return { errors: [{ message: 'indexer is not synced' }] } as T;
      },
      async getJson<T>(): Promise<T> {
        throw new Error('not used');
      },
    };
    const provider = new UniswapPoolProvider({ endpoint: 'https://example.invalid', http, ttlMs: 0 });
    await assert.rejects(() => provider.deepestPool(USDC, WETH), /not synced/);
  });

  test('results are cached within the TTL', async () => {
    let calls = 0;
    const http: HttpClient = {
      async postJson<T>(): Promise<T> {
        calls += 1;
        return { data: { pools: [{ id: '0xa', feeTier: '3000', totalValueLockedUSD: '1', volumeUSD: '1' }] } } as T;
      },
      async getJson<T>(): Promise<T> {
        throw new Error('not used');
      },
    };
    const provider = new UniswapPoolProvider({ endpoint: 'https://example.invalid', http, ttlMs: 60_000 });

    await provider.deepestPool(USDC, WETH);
    await provider.deepestPool(WETH, USDC); // same pair, either order
    assert.equal(calls, 1, 'the pair key must be order-independent');
  });
});

describe('PoolLiquidityPolicy', () => {
  const policy = new PoolLiquidityPolicy(50_000);

  test('a deep pool passes', () => {
    const outcome = policy.evaluate(swap, baseState({ id: '0xdeep', feeTier: 3000, totalValueLockedUSD: 412_000, volumeUSD: 9_000 }));
    assert.equal(outcome.decision, 'ALLOW');
  });

  test('a pool under the floor is blocked, with the figure in the reason', () => {
    const outcome = policy.evaluate(swap, baseState({ id: '0xthin', feeTier: 500, totalValueLockedUSD: 42, volumeUSD: 0 }));
    assert.equal(outcome.decision, 'BLOCK');
    assert.match(outcome.reason ?? '', /\$42/);
    assert.equal(outcome.violation?.policy, 'poolLiquidity');
  });

  test('no indexed pool is a block — the venue cannot be verified', () => {
    assert.equal(policy.evaluate(swap, baseState(null)).decision, 'BLOCK');
  });

  test('state we could not fetch is not a block', () => {
    // The engine reports this policy as unevaluated instead. An outage at The
    // Graph must not become a blanket refusal to trade.
    assert.equal(policy.evaluate(swap, baseState(undefined)).decision, 'ALLOW');
  });

  test('non-swaps are unaffected, since they have no venue', () => {
    const transfer: NormalizedIntent = { ...swap, kind: 'TRANSFER' };
    assert.equal(policy.evaluate(transfer, baseState(null)).decision, 'ALLOW');
  });
});
