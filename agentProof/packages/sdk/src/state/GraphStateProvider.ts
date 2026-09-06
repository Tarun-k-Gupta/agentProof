import type { Address, Hex, NormalizedIntent } from '../core/types.ts';
import type { ChainReader, HttpClient, Logger, StateProvider } from '../ports/index.ts';
import { keccak256 } from '../crypto/keccak.ts';
import { normalizeAddress } from '../utils/hex.ts';
import { displayUsdc } from '../utils/units.ts';

export interface GraphStateProviderOptions {
  /** Subgraph Studio query URL */
  endpoint: string;
  apiKey: string;
  http: HttpClient;
  /** the deployed AgentPolicyHook, used to reconcile against the chain */
  hook: Address;
  chain?: ChainReader;
  logger?: Logger;
  /** cache TTL in ms; a hard read-through is forced for approvals */
  ttlMs?: number;
}

interface DailyAggregateResponse {
  data?: {
    dailyAggregates: Array<{ id: string; totalOutflow: string; executionCount: number }>;
    agent?: { lastReconciledBlock: string } | null;
  };
  errors?: Array<{ message: string }>;
}

const DAILY_SPEND_QUERY = `
  query DailySpend($account: String!, $day: Int!) {
    dailyAggregates(where: { account: $account, day: $day }, first: 1) {
      id
      totalOutflow
      executionCount
    }
  }
`;

/**
 * Historical spend, read from our own subgraph.
 *
 * This is the load-bearing part of the Graph integration: the daily-spend
 * decision is *made from* the query result. If the subgraph is unreachable, the
 * agent does not fall back to guessing — it falls back to the chain, and if
 * that also fails, it fails closed.
 *
 * Indexer lag is real and we handle it explicitly rather than pretending it
 * away. Every read is reconciled against the hook's on-chain accumulator:
 *
 *   - values agree                     → use the indexed value
 *   - indexer is behind the chain      → trust the chain, log STATE_DIVERGENCE
 *   - indexer is *ahead* of the chain  → trust the higher value, log loudly;
 *                                        an indexer claiming more spend than
 *                                        the chain has recorded is either a
 *                                        reorg or a bug, and in both cases the
 *                                        conservative number is the safe one
 *
 * The rule in one line: when sources disagree about how much has been spent,
 * believe the one that permits less.
 */
export class GraphStateProvider implements StateProvider {
  private readonly cache = new Map<string, { value: bigint; expiresAt: number }>();
  private readonly ttlMs: number;

  constructor(private readonly options: GraphStateProviderOptions) {
    this.ttlMs = options.ttlMs ?? 15_000;
  }

  async getDailySpend(account: Address, dayUtc: number, opts: { fresh?: boolean } = {}): Promise<bigint> {
    const key = `${account.toLowerCase()}:${dayUtc}`;
    const cached = this.cache.get(key);
    if (!opts.fresh && cached && cached.expiresAt > Date.now()) return cached.value;

    const indexed = await this.queryIndexedSpend(account, dayUtc);
    const onchain = await this.readOnchainSpend(account, dayUtc);

    const value = this.reconcile(account, indexed, onchain);
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    return value;
  }

  async getBalance(account: Address, asset: Address): Promise<bigint> {
    if (!this.options.chain) throw new Error('GraphStateProvider needs a ChainReader to read balances');
    return this.options.chain.getErc20Balance(asset, account);
  }

  async recordExecution(account: Address, intent: NormalizedIntent, txHash: Hex): Promise<void> {
    // The subgraph is the system of record; it indexes SpendRecorded from the
    // hook. We only invalidate the cache so the next read reflects the new
    // execution once the indexer catches up.
    this.cache.delete(`${account.toLowerCase()}:${currentDay()}`);
    this.options.logger?.log('debug', 'execution recorded', {
      account,
      txHash,
      kind: intent.kind,
      notional: intent.notionalUSDC.toString(),
    });
  }

  // ---------------------------------------------------------------- internals

  private async queryIndexedSpend(account: Address, dayUtc: number): Promise<bigint | undefined> {
    try {
      const response = await this.options.http.postJson<DailyAggregateResponse>(
        this.options.endpoint,
        { query: DAILY_SPEND_QUERY, variables: { account: account.toLowerCase(), day: dayUtc } },
        { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
      );

      if (response.errors?.length) {
        this.options.logger?.log('warn', 'subgraph returned errors', {
          errors: response.errors.map((e) => e.message),
        });
        return undefined;
      }
      const row = response.data?.dailyAggregates?.[0];
      return row ? BigInt(row.totalOutflow) : 0n;
    } catch (error) {
      this.options.logger?.log('warn', 'subgraph unreachable, falling back to chain', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /** Reads `window(account)` from the hook: (uint64 day, uint256 spent). */
  private async readOnchainSpend(account: Address, dayUtc: number): Promise<bigint | undefined> {
    const chain = this.options.chain;
    if (!chain) return undefined;
    try {
      // window(address) selector, computed once at module load.
      const data = `${WINDOW_SELECTOR}${account.slice(2).toLowerCase().padStart(64, '0')}` as Hex;
      const raw = await chain.call(this.options.hook, data);
      if (raw.length < 2 + 128) return undefined;
      const day = Number(BigInt(`0x${raw.slice(2, 66)}`));
      const spent = BigInt(`0x${raw.slice(66, 130)}`);
      // A stale window from a previous day means nothing has been spent today.
      return day === dayUtc ? spent : 0n;
    } catch (error) {
      this.options.logger?.log('warn', 'hook accumulator read failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private reconcile(account: Address, indexed: bigint | undefined, onchain: bigint | undefined): bigint {
    if (indexed === undefined && onchain === undefined) {
      // Fail closed. An agent that cannot establish how much it has already
      // spent must not be allowed to spend more.
      throw new StateUnavailableError(account);
    }
    if (indexed === undefined) return onchain!;
    if (onchain === undefined) return indexed;

    if (indexed !== onchain) {
      const chosen = indexed > onchain ? indexed : onchain;
      this.options.logger?.log('warn', 'STATE_DIVERGENCE', {
        account: normalizeAddress(account),
        indexed: displayUsdc(indexed),
        onchain: displayUsdc(onchain),
        using: displayUsdc(chosen),
        note: indexed < onchain ? 'indexer is behind the chain' : 'indexer reports more spend than the chain',
      });
      return chosen;
    }
    return indexed;
  }
}

export class StateUnavailableError extends Error {
  constructor(account: Address) {
    super(
      `Cannot determine today's spend for ${account}: both the subgraph and the on-chain ` +
        'accumulator are unreachable. Failing closed.',
    );
    this.name = 'StateUnavailableError';
  }
}

/**
 * Derived rather than hardcoded, so a signature change in the hook can never
 * silently turn the reconciliation read into a no-op.
 */
const WINDOW_SELECTOR = keccak256('window(address)').slice(0, 10);

function currentDay(): number {
  return Math.floor(Date.now() / 1000 / 86_400);
}
