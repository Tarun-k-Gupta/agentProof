import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GraphStateProvider, StateUnavailableError } from '../../src/state/GraphStateProvider.ts';
import { DailySpendPolicy } from '../../src/policies/index.ts';
import type { Address, Hex } from '../../src/core/types.ts';
import type { ChainReader, HttpClient, LogLevel, Logger } from '../../src/ports/index.ts';
import { usdc } from '../../src/utils/units.ts';

/**
 * Reconciliation between the subgraph and the hook's own accumulator.
 *
 * Every case here is one an indexer actually produces. The rule under test is
 * the same in all four: when two sources disagree about how much has already
 * been spent, believe the one that permits less — and when neither source can
 * answer, refuse to answer at all.
 */

const ACCOUNT = '0x00000000000000000000000000000000000000a1' as Address;
const HOOK = '0x00000000000000000000000000000000000000b2' as Address;
const DAY = 20_000;

class RecordingLogger implements Logger {
  readonly lines: Array<{ level: LogLevel; message: string; fields?: Record<string, unknown> }> = [];
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    this.lines.push({ level, message, fields });
  }
  has(message: string): boolean {
    return this.lines.some((line) => line.message === message);
  }
}

/** A subgraph that answers with `indexed`, or fails if it is null. */
function subgraph(indexed: bigint | null): HttpClient {
  return {
    async postJson<T>(): Promise<T> {
      if (indexed === null) throw new Error('subgraph unreachable');
      return {
        data: { dailyAggregates: [{ id: `${ACCOUNT}-${DAY}`, totalOutflow: indexed.toString(), executionCount: 1 }] },
      } as T;
    },
    async getJson<T>(): Promise<T> {
      throw new Error('not used');
    },
  };
}

/** A chain whose hook accumulator reads `onchain` for `day`, or fails if null. */
function chainReader(onchain: bigint | null, day = DAY): ChainReader {
  return {
    chainId: 11155111,
    async getErc20Balance() {
      return usdc(1000);
    },
    async call(): Promise<Hex> {
      if (onchain === null) throw new Error('rpc unreachable');
      const word = (value: bigint) => value.toString(16).padStart(64, '0');
      return `0x${word(BigInt(day))}${word(onchain)}` as Hex;
    },
    async getBlockTimestamp() {
      return DAY * 86_400;
    },
  };
}

function provider(options: { indexed: bigint | null; onchain: bigint | null; day?: number; logger?: Logger }) {
  return new GraphStateProvider({
    endpoint: 'https://gateway.thegraph.com/api/subgraphs/id/test',
    apiKey: 'test-key',
    http: subgraph(options.indexed),
    hook: HOOK,
    chain: options.onchain === undefined ? undefined : chainReader(options.onchain, options.day),
    logger: options.logger,
    ttlMs: 0,
  });
}

describe('Graph/chain reconciliation', () => {
  test('agreeing sources return the agreed value and log no divergence', async () => {
    const logger = new RecordingLogger();
    const spend = await provider({ indexed: usdc(120), onchain: usdc(120), logger }).getDailySpend(ACCOUNT, DAY);

    assert.equal(spend, usdc(120));
    assert.ok(!logger.has('STATE_DIVERGENCE'));
  });

  test('an indexer behind the chain does not under-report spend', async () => {
    const logger = new RecordingLogger();
    // The classic case: the swap landed, the indexer has not caught up.
    const spend = await provider({ indexed: usdc(100), onchain: usdc(300), logger }).getDailySpend(ACCOUNT, DAY);

    assert.equal(spend, usdc(300), 'the chain has recorded more spend, so the chain wins');
    assert.ok(logger.has('STATE_DIVERGENCE'));
    assert.equal(
      logger.lines.find((l) => l.message === 'STATE_DIVERGENCE')?.fields?.note,
      'indexer is behind the chain',
    );
  });

  test('an indexer ahead of the chain is still believed, because it permits less', async () => {
    const logger = new RecordingLogger();
    // A reorg or a mapping bug. Either way the conservative number is the safe one.
    const spend = await provider({ indexed: usdc(400), onchain: usdc(100), logger }).getDailySpend(ACCOUNT, DAY);

    assert.equal(spend, usdc(400));
    assert.equal(
      logger.lines.find((l) => l.message === 'STATE_DIVERGENCE')?.fields?.note,
      'indexer reports more spend than the chain',
    );
  });

  test('a stale on-chain window from a previous day reads as zero spent today', async () => {
    const spend = await provider({ indexed: 0n, onchain: usdc(450), day: DAY - 1 }).getDailySpend(ACCOUNT, DAY);
    assert.equal(spend, 0n, "yesterday's accumulator says nothing about today");
  });

  test('an unreachable subgraph falls back to the chain', async () => {
    const spend = await provider({ indexed: null, onchain: usdc(250) }).getDailySpend(ACCOUNT, DAY);
    assert.equal(spend, usdc(250));
  });

  test('an unreachable chain falls back to the subgraph', async () => {
    const spend = await provider({ indexed: usdc(250), onchain: null }).getDailySpend(ACCOUNT, DAY);
    assert.equal(spend, usdc(250));
  });

  test('both sources unavailable fails closed rather than assuming zero', async () => {
    await assert.rejects(
      () => provider({ indexed: null, onchain: null }).getDailySpend(ACCOUNT, DAY),
      (error: unknown) => {
        assert.ok(error instanceof StateUnavailableError);
        assert.match((error as Error).message, /Failing closed/);
        return true;
      },
    );
  });

  test('a subgraph that returns GraphQL errors counts as no answer, not as zero', async () => {
    const http: HttpClient = {
      async postJson<T>(): Promise<T> {
        return { errors: [{ message: 'indexer is not synced' }] } as T;
      },
      async getJson<T>(): Promise<T> {
        throw new Error('not used');
      },
    };
    const state = new GraphStateProvider({
      endpoint: 'https://example.invalid',
      apiKey: 'k',
      http,
      hook: HOOK,
      chain: chainReader(usdc(90)),
      ttlMs: 0,
    });

    assert.equal(await state.getDailySpend(ACCOUNT, DAY), usdc(90));
  });
});

describe('the Graph result drives the decision', () => {
  /**
   * The point of the integration, stated as a test: the same action is allowed
   * or blocked purely because of what the subgraph returned. If this passes with
   * the query stubbed out, the integration is decorative.
   */
  const policy = new DailySpendPolicy(usdc(500));

  async function decide(indexed: bigint) {
    const state = provider({ indexed, onchain: indexed });
    const dailySpend = await state.getDailySpend(ACCOUNT, DAY);
    return policy.evaluate(
      { notionalUSDC: usdc(100) } as never,
      { account: ACCOUNT, dayUtc: DAY, dailySpend, balance: usdc(1000), asset: ACCOUNT, now: Date.now() },
    );
  }

  test('spend well inside the window is allowed', async () => {
    assert.equal((await decide(usdc(100))).decision, 'ALLOW');
  });

  test('the same action is blocked once indexed history fills the window', async () => {
    const outcome = await decide(usdc(450));
    assert.equal(outcome.decision, 'BLOCK');
    assert.match(outcome.reason ?? '', /daily limit/i);
  });

  test('the boundary is exact: spending to precisely the limit is allowed', async () => {
    assert.equal((await decide(usdc(400))).decision, 'ALLOW', '400 + 100 == 500 is within a 500 limit');
    assert.equal((await decide(usdc(400) + 1n)).decision, 'BLOCK', 'one base unit over is not');
  });
});
