import type {
  Address,
  NormalizedIntent,
  Policy,
  PolicyEvaluation,
  PolicyState,
} from '../core/types.ts';
import { displayUsdc } from '../utils/units.ts';

const pass: PolicyEvaluation = { decision: 'ALLOW' };

/**
 * P1 — Max transaction value.
 *
 * Formally verified as MAX_TRANSFER in contracts/formal/PolicySpec.sol, and
 * enforced independently by the hook on a MEASURED balance delta. This class is
 * the advisory L1 copy of that rule; if the two ever disagree the differential
 * fuzz test fails.
 */
export class MaxTransactionPolicy implements Policy {
  readonly id = 'maxTransaction';
  readonly formallyVerified = true;

  constructor(private readonly limit: bigint) {}

  evaluate(intent: NormalizedIntent, _state: PolicyState): PolicyEvaluation {
    if (intent.notionalUSDC <= this.limit) return pass;
    return {
      decision: 'BLOCK',
      reason: `${displayUsdc(intent.notionalUSDC)} exceeds the ${displayUsdc(this.limit)} per-transaction limit`,
      violation: {
        policy: this.id,
        limit: this.limit,
        observed: intent.notionalUSDC,
        provenance: intent.outflow[0]?.provenance ?? 'DECLARED',
        message: 'per-transaction ceiling exceeded',
      },
    };
  }
}

/**
 * P2 — Cumulative daily spend.
 *
 * Defeats salami slicing (T5): twenty 40-USDC transfers under a 100-USDC
 * per-transaction limit still hit the daily ceiling.
 *
 * The UTC-day bucket is a deliberate, documented choice, not an oversight. Two
 * full daily limits can be spent a minute apart across midnight (T6). A rolling
 * window is listed as future work rather than quietly implied.
 */
export class DailySpendPolicy implements Policy {
  readonly id = 'dailySpend';
  readonly formallyVerified = true;

  constructor(private readonly limit: bigint) {}

  evaluate(intent: NormalizedIntent, state: PolicyState): PolicyEvaluation {
    const wouldBe = state.dailySpend + intent.notionalUSDC;
    if (wouldBe <= this.limit) return pass;
    return {
      decision: 'BLOCK',
      reason:
        `this would bring today's spend to ${displayUsdc(wouldBe)}, ` +
        `over the ${displayUsdc(this.limit)} daily limit ` +
        `(${displayUsdc(state.dailySpend)} already spent)`,
      violation: {
        policy: this.id,
        limit: this.limit,
        observed: wouldBe,
        provenance: 'DECODED',
        message: 'daily cumulative ceiling exceeded',
      },
    };
  }
}

/**
 * P3 + P4 — Allowlisted contracts and recipients.
 *
 * The anti-prompt-injection control (T2). Evaluated first among the value
 * policies because it is the cheapest check and because a call to an
 * unrecognised address should never have its amount discussed at all.
 */
export class AllowlistPolicy implements Policy {
  readonly id = 'allowlist';
  readonly formallyVerified = false;

  constructor(
    private readonly contracts: ReadonlySet<Address>,
    private readonly recipients: ReadonlySet<Address>,
    private readonly options: { allowUnknownSelectors?: boolean } = {},
  ) {}

  evaluate(intent: NormalizedIntent, _state?: PolicyState): PolicyEvaluation {
    if (intent.kind === 'UNKNOWN' && !this.options.allowUnknownSelectors) {
      return {
        decision: 'BLOCK',
        reason: `calldata ${intent.selector} could not be decoded, so its spend cannot be bounded`,
        violation: {
          policy: 'unknownSelector',
          limit: 0n,
          observed: intent.notionalUSDC,
          provenance: 'DECLARED',
          message: 'undecodable calldata',
        },
      };
    }

    if (!this.contracts.has(intent.target)) {
      return {
        decision: 'BLOCK',
        reason: `${intent.target} is not an allowlisted contract`,
        violation: {
          policy: 'allowedContracts',
          limit: BigInt(this.contracts.size),
          observed: 0n,
          provenance: 'DECODED',
          message: 'target not in allowlist',
        },
      };
    }

    const counterparty = intent.counterparty;
    if (counterparty !== undefined && this.movesValue(intent)) {
      const known = this.recipients.has(counterparty) || this.contracts.has(counterparty);
      if (!known) {
        return {
          decision: 'BLOCK',
          reason: `${counterparty} is not an allowlisted recipient`,
          violation: {
            policy: 'allowedRecipients',
            limit: BigInt(this.recipients.size),
            observed: 0n,
            provenance: 'DECODED',
            message: 'counterparty not in allowlist',
          },
        };
      }
    }

    return pass;
  }

  private movesValue(intent: NormalizedIntent): boolean {
    return intent.outflow.some((flow) => flow.amount > 0n);
  }
}

/**
 * P5 — Minimum wallet balance.
 *
 * A floor is only truly meaningful after the fact, which is why the hook
 * enforces it in postCheck. Here it is a pre-flight estimate using the
 * worst-case decoded outflow.
 */
export class MinBalancePolicy implements Policy {
  readonly id = 'minBalance';
  readonly formallyVerified = false;

  constructor(private readonly floor: bigint) {}

  evaluate(intent: NormalizedIntent, state: PolicyState): PolicyEvaluation {
    const projected = state.balance - intent.notionalUSDC;
    if (projected >= this.floor) return pass;
    return {
      decision: 'BLOCK',
      reason:
        `this would leave ${displayUsdc(projected < 0n ? 0n : projected)}, ` +
        `below the ${displayUsdc(this.floor)} reserve`,
      violation: {
        policy: this.id,
        limit: this.floor,
        observed: projected < 0n ? 0n : projected,
        provenance: 'DECODED',
        message: 'reserve balance would be breached',
      },
    };
  }
}

/**
 * P6 — Human approval threshold.
 *
 * Evaluated last, because it can only ever upgrade an otherwise-passing action
 * to REQUIRE_APPROVAL. It never rescues a BLOCK.
 *
 * On-chain the hook cannot ask a human mid-execution, so anything above the
 * threshold simply reverts. The approval path re-signs with the owner validator
 * instead, which carries a raised ceiling. That is a design point, not a gap:
 * the escalation is a different key, not a softer rule.
 */
export class ApprovalThresholdPolicy implements Policy {
  readonly id = 'approvalThreshold';
  readonly formallyVerified = false;

  constructor(private readonly threshold: bigint) {}

  evaluate(intent: NormalizedIntent, _state?: PolicyState): PolicyEvaluation {
    if (intent.notionalUSDC < this.threshold) return pass;
    return {
      decision: 'REQUIRE_APPROVAL',
      reason: `${displayUsdc(intent.notionalUSDC)} is at or above the ${displayUsdc(this.threshold)} approval threshold`,
    };
  }
}

/**
 * P7 — Pool plausibility (cross-protocol).
 *
 * Reads the deepest pool for the pair from a public Uniswap subgraph and
 * refuses a swap against one too thin to trade in. This is the second Graph
 * product in the integration: our own subgraph says how much the agent has
 * spent, this one says whether the venue is real.
 *
 * It is not a price or slippage control — those are out of scope per the threat
 * model. It bounds a different failure: the spend limits stop an agent losing
 * more than 100 USDC in a transaction, and do nothing at all about that 100
 * USDC buying dust in a pool with 40 dollars in it.
 *
 * Advisory-only by construction: there is no on-chain counterpart, so this
 * cannot be enforced by the hook and is not claimed to be.
 */
export class PoolLiquidityPolicy implements Policy {
  readonly id = 'poolLiquidity';
  readonly formallyVerified = false;

  constructor(private readonly minTvlUsd: number) {}

  evaluate(intent: NormalizedIntent, state?: PolicyState): PolicyEvaluation {
    // Only swaps route through a pool; a transfer has no venue to check.
    if (intent.kind !== 'SWAP') return pass;

    // Not fetched, or the subgraph was unreachable. The engine reports this
    // policy as unevaluated rather than passing it silently.
    if (state?.pool === undefined) return pass;

    if (state.pool === null) {
      return {
        decision: 'BLOCK',
        reason: 'no Uniswap pool is indexed for this pair, so the swap has no venue we can verify',
        violation: {
          policy: this.id,
          limit: BigInt(Math.round(this.minTvlUsd)),
          observed: 0n,
          provenance: 'DECODED',
          message: 'no indexed pool',
        },
      };
    }

    const tvl = state.pool.totalValueLockedUSD;
    if (tvl >= this.minTvlUsd) return pass;

    return {
      decision: 'BLOCK',
      reason:
        `the deepest pool for this pair holds about $${Math.round(tvl).toLocaleString('en-US')}, ` +
        `under the $${this.minTvlUsd.toLocaleString('en-US')} floor — too thin to trade into`,
      violation: {
        policy: this.id,
        limit: BigInt(Math.round(this.minTvlUsd)),
        observed: BigInt(Math.round(tvl)),
        provenance: 'DECODED',
        message: 'pool liquidity below the configured floor',
      },
    };
  }
}
