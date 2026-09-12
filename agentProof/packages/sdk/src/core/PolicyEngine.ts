import type {
  Action,
  Decision,
  NormalizedIntent,
  Policy,
  PolicyCheck,
  PolicyResult,
  PolicyRow,
  PolicyState,
  PolicyViolation,
  ProofReference,
} from './types.ts';
import type { DecoderContext, DecoderRegistry } from '../decode/index.ts';

export interface PolicyEngineOptions {
  decoders: DecoderRegistry;
  policies: readonly Policy[];
  decoderContext: DecoderContext;
  /** looked up by policy id; attached to the result when that policy decides */
  proofs?: ReadonlyMap<string, ProofReference>;
}

/**
 * The one implementation of every decision.
 *
 * The SDK, the HTTP Verification API and the x402-gated service all call this
 * class. There is deliberately no second copy of the logic anywhere — a safety
 * product with two policy engines has no policy engine.
 *
 * Evaluation is pure and synchronous. All I/O (balances, indexer reads) happens
 * before the call, in the PolicyState the caller assembles. That is what makes
 * the engine fuzzable against the Solidity library and reproducible from a log.
 */
export class PolicyEngine {
  private sequence = 0;

  constructor(private readonly options: PolicyEngineOptions) {}

  /** Calldata → intent. Exposed separately for POST /v1/decode. */
  decode(action: Action, context?: Partial<DecoderContext>): NormalizedIntent {
    return this.options.decoders.decode(action, { ...this.options.decoderContext, ...context });
  }

  /**
   * Evaluates an already-decoded intent against every policy.
   *
   * Order (fixed, documented, tested):
   *   1. allowlist          cheapest, and catches prompt injection first
   *   2. maxTransaction
   *   3. minBalance
   *   4. dailySpend
   *   5. approvalThreshold  last, since it can only upgrade a pass
   *
   * Rules:
   *   - a BLOCK settles the decision; the violations returned are those found up
   *     to and including the policy that blocked
   *   - REQUIRE_APPROVAL never overrides a BLOCK
   *   - ALLOW requires every policy to pass
   *
   * Every policy is still evaluated even after a BLOCK, so `checks` carries a
   * full row per policy for the dashboard. Those evaluations are pure; only the
   * decision short-circuits.
   */
  evaluate(intent: NormalizedIntent, state: PolicyState): PolicyResult {
    const violations: PolicyViolation[] = [];
    const policyRows: PolicyRow[] = [];
    const checks: PolicyCheck[] = [];
    let decision: Decision = 'ALLOW';
    let reason = 'within all policy limits';
    let decidingPolicy: string | undefined;
    let settled = false;

    for (const policy of this.options.policies) {
      const evaluation = policy.evaluate(intent, state);
      policyRows.push({
        id: policy.id,
        name: labelPolicy(policy.id),
        decision: evaluation.decision,
        passed: evaluation.decision === 'ALLOW',
        formallyVerified: policy.formallyVerified,
        reason: evaluation.reason ?? (evaluation.decision === 'ALLOW' ? 'passed' : 'policy decided'),
        limit: evaluation.violation?.limit,
        observed: evaluation.violation?.observed,
        provenance: evaluation.violation?.provenance,
      });

      checks.push({
        policy: policy.id,
        decision: evaluation.decision,
        reason: evaluation.reason,
        provenance: evaluation.violation?.provenance,
      });

      if (settled) continue;

      if (evaluation.violation) violations.push(evaluation.violation);

        if (evaluation.decision === 'BLOCK') {
        decision = 'BLOCK';
        reason = evaluation.reason ?? 'blocked by policy';
        decidingPolicy = policy.id;
        settled = true;
        continue;
      }

      if (evaluation.decision === 'REQUIRE_APPROVAL' && decision === 'ALLOW') {
        decision = 'REQUIRE_APPROVAL';
        reason = evaluation.reason ?? 'human approval required';
        decidingPolicy = policy.id;
      }
    }

    return this.result(decision, reason, intent, violations, policyRows, checks, decidingPolicy);
  }

  /** Convenience: decode then evaluate. */
  verify(action: Action, state: PolicyState): PolicyResult {
    return this.evaluate(this.decode(action), state);
  }

  private result(
    decision: Decision,
    reason: string,
    intent: NormalizedIntent,
    violations: PolicyViolation[],
    policyRows: PolicyRow[],
    checks: PolicyCheck[],
    decidingPolicy?: string,
  ): PolicyResult {
    return {
      decision,
      reason,
      intent,
      violations,
      policyRows,
      checks,
      // A proof reference is attached only when the policy that actually
      // decided is one we have a proof for. Attaching proofs to unrelated
      // decisions would be proof theatre.
      proof: decidingPolicy ? this.options.proofs?.get(decidingPolicy) : undefined,
      sequence: ++this.sequence,
      evaluatedAt: Date.now(),
    };
  }
}

function labelPolicy(id: string): string {
  switch (id) {
    case 'allowlist':
      return 'Allowed contract / recipient';
    case 'maxTransaction':
      return 'Max transaction';
    case 'minBalance':
      return 'Minimum balance';
    case 'dailySpend':
      return 'Daily spend';
    case 'approvalThreshold':
      return 'Human approval threshold';
    default:
      return id;
  }
}
