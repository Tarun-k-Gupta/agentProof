import type { Address } from '../core/types.ts';
import type { HttpClient, Logger } from '../ports/index.ts';

/**
 * Pool state, read from a public Uniswap subgraph.
 *
 * This is the second Graph product in the integration (PRD 10.3 item 3): our
 * own agent-history subgraph answers "how much has this agent already spent",
 * and this one answers "is the pool it wants to trade against real". Two
 * independent subgraphs, one decision.
 *
 * What it is for: a swap routed through a pool with almost no liquidity is
 * either a mistake or a trap. The agent will get a catastrophic price, and the
 * spend limits will not save it — 80 USDC of outflow is 80 USDC of outflow
 * whether it buys something or nothing. Bounding the spend and bounding the
 * *loss* are different problems, and this is the cheapest available handle on
 * the second.
 *
 * What it is not for: pricing, slippage, or MEV. Those are out of scope per the
 * threat model, and a subgraph read is the wrong instrument for them anyway.
 */

export interface PoolState {
  /** total value locked in the pool, in USD as the subgraph reports it */
  totalValueLockedUSD: number;
  /** trailing 24h volume in USD */
  volumeUSD: number;
  feeTier: number;
  id: string;
}

export interface UniswapPoolProviderOptions {
  endpoint: string;
  http: HttpClient;
  apiKey?: string;
  logger?: Logger;
  ttlMs?: number;
}

const POOL_QUERY = `
  query Pools($tokens: [String!]) {
    pools(
      where: { token0_in: $tokens, token1_in: $tokens }
      orderBy: totalValueLockedUSD
      orderDirection: desc
      first: 5
    ) {
      id
      feeTier
      totalValueLockedUSD
      volumeUSD
    }
  }
`;

interface PoolsResponse {
  data?: {
    pools?: Array<{ id: string; feeTier: string; totalValueLockedUSD: string; volumeUSD: string }>;
  };
  errors?: Array<{ message: string }>;
}

export class UniswapPoolProvider {
  private readonly cache = new Map<string, { value: PoolState | null; expiresAt: number }>();
  private readonly ttlMs: number;

  constructor(private readonly options: UniswapPoolProviderOptions) {
    this.ttlMs = options.ttlMs ?? 60_000;
  }

  /**
   * The deepest pool for a token pair, or `null` when the subgraph answered and
   * knows of none.
   *
   * @throws when the subgraph could not be reached at all. The distinction
   *   matters: "there is no pool" is a finding, "we could not ask" is not, and
   *   collapsing the two would turn an outage into a policy verdict.
   */
  async deepestPool(tokenA: Address, tokenB: Address): Promise<PoolState | null> {
    const key = [tokenA, tokenB].map((t) => t.toLowerCase()).sort().join(':');
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const response = await this.options.http.postJson<PoolsResponse>(
      this.options.endpoint,
      { query: POOL_QUERY, variables: { tokens: key.split(':') } },
      this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {},
    );

    if (response.errors?.length) {
      throw new Error(`Uniswap subgraph error: ${response.errors.map((e) => e.message).join('; ')}`);
    }

    const rows = response.data?.pools ?? [];
    const best = rows[0]
      ? {
          id: rows[0].id,
          feeTier: Number(rows[0].feeTier),
          totalValueLockedUSD: Number(rows[0].totalValueLockedUSD),
          volumeUSD: Number(rows[0].volumeUSD),
        }
      : null;

    this.cache.set(key, { value: best, expiresAt: Date.now() + this.ttlMs });
    this.options.logger?.log('debug', 'uniswap pool state', { pair: key, pool: best?.id, tvl: best?.totalValueLockedUSD });
    return best;
  }
}
