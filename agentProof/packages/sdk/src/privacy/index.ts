import type { Address, Hex, NormalizedIntent, PolicyResult } from '../core/types.ts';
import { keccak256 } from '../crypto/keccak.ts';
import { displayUsdc } from '../utils/units.ts';

/**
 * Privacy.
 *
 * A safety runtime sees everything an agent does. That makes it a surveillance
 * surface by default, and the honest response is to design against ourselves.
 * Four rules, each implemented here rather than promised in a README:
 *
 *   1. Evaluate locally.        The policy engine is in-process and needs no
 *                              network. The hosted API exists for agents that
 *                              cannot embed it, and it is stateless.
 *   2. Log shapes, not values.  Addresses are truncated and secrets are
 *                              structurally unloggable.
 *   3. Publish commitments.     The public audit trail carries a hash that
 *                              binds a decision to its inputs, not the inputs.
 *   4. Bucket public amounts.   Anything leaving for a public ledger is coarse
 *                              enough not to reconstruct a treasury.
 */

// ------------------------------------------------------------------ redaction

const SECRET_KEY_PATTERN = /(privateKey|apiKey|secret|mnemonic|seed|sessionKey|authorization|x-payment)/i;
const HEX_KEY_PATTERN = /\b0x[0-9a-fA-F]{64}\b/g;

/** `0x1234…cdef` — enough to correlate within a log, not enough to publish. */
export function truncateAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return '[not-an-address]';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Recursively redacts a value for logging.
 *
 * Keys that look like secrets are replaced wholesale rather than truncated —
 * a truncated private key is still a meaningful reduction in search space.
 * Any loose 32-byte hex string is masked too, because that is the shape of both
 * a private key and a signature and we would rather lose a hash from a log than
 * leak a key into one.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    if (/^0x[0-9a-fA-F]{40}$/.test(value)) return truncateAddress(value);
    return value.replace(HEX_KEY_PATTERN, '0x[redacted-32-bytes]');
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redact(item, depth + 1);
  }
  return out;
}

// ---------------------------------------------------------------- commitments

/**
 * A per-process salt. Never logged, never transmitted, regenerated on restart.
 *
 * Its only job is to stop an observer from brute-forcing a commitment: the
 * input space of (account, amount, counterparty) is small enough to enumerate
 * without one.
 */
function freshSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}` as Hex;
}

export class CommitmentScheme {
  private readonly salt: Hex;

  constructor(salt?: Hex) {
    this.salt = salt ?? freshSalt();
  }

  /**
   * Binds a decision to the exact intent that produced it, without revealing
   * the intent.
   *
   * Publishing this to a public topic lets anyone verify later — once the
   * operator chooses to reveal the preimage — that the audit entry was not
   * written after the fact. Until then it discloses nothing about who paid whom
   * or how much.
   */
  commit(account: Address, intent: NormalizedIntent, decision: string): Hex {
    return keccak256(
      [
        this.salt,
        account.toLowerCase(),
        intent.kind,
        intent.target,
        intent.counterparty ?? '0x',
        intent.notionalUSDC.toString(),
        decision,
      ].join('|'),
    );
  }

  /** Reveals the preimage for a specific entry, for a judge or an auditor. */
  reveal(account: Address, intent: NormalizedIntent, decision: string): { commitment: Hex; preimage: string } {
    const preimage = [
      this.salt,
      account.toLowerCase(),
      intent.kind,
      intent.target,
      intent.counterparty ?? '0x',
      intent.notionalUSDC.toString(),
      decision,
    ].join('|');
    return { commitment: keccak256(preimage), preimage };
  }
}

// -------------------------------------------------------------------- buckets

const BUCKET_EDGES = [1n, 10n, 100n, 1_000n, 10_000n, 100_000n];

/**
 * Coarsens an amount before it reaches a public ledger.
 *
 * An HCS topic is permanent and world-readable. Writing exact amounts to it
 * would publish an agent's complete cash-flow history to anyone who cares to
 * read, which is a strictly worse privacy position than not having an audit
 * trail at all. Order-of-magnitude buckets keep the trail useful for
 * "was this agent behaving?" while making it useless for "how much does this
 * treasury hold?".
 */
export function bucketAmount(baseUnits: bigint, decimals = 6): string {
  const whole = baseUnits / 10n ** BigInt(decimals);
  if (whole <= 0n) return '<1';
  for (let i = 0; i < BUCKET_EDGES.length - 1; i++) {
    if (whole < BUCKET_EDGES[i + 1]) return `${BUCKET_EDGES[i]}-${BUCKET_EDGES[i + 1]}`;
  }
  return `>=${BUCKET_EDGES[BUCKET_EDGES.length - 1]}`;
}

// ------------------------------------------------------------- public records

export interface PublicAuditRecord {
  /** which policy version governed the decision — public by design */
  policyHash: Hex;
  decision: string;
  /** the policy that decided, not the values it saw */
  decidedBy: string;
  /** order-of-magnitude only */
  amountBucket: string;
  /** binds this record to the full intent, without disclosing it */
  commitment: Hex;
  /** UTC day, not a timestamp: enough for ordering, not for behavioural timing */
  dayUtc: number;
  proofStatus?: string;
}

/**
 * Projects a full PolicyResult down to what is safe to publish.
 *
 * Everything that could identify a counterparty, an exact amount or a moment in
 * time is dropped here, at the single point where data leaves for a public
 * ledger. Making that projection one function — rather than a habit — is what
 * stops the next feature from quietly widening it.
 */
export function toPublicAuditRecord(
  result: PolicyResult,
  account: Address,
  policyHash: Hex,
  commitments: CommitmentScheme,
): PublicAuditRecord {
  return {
    policyHash,
    decision: result.decision,
    decidedBy: result.violations[0]?.policy ?? (result.decision === 'ALLOW' ? 'none' : 'approvalThreshold'),
    amountBucket: bucketAmount(result.intent.notionalUSDC),
    commitment: commitments.commit(account, result.intent, result.decision),
    dayUtc: Math.floor(result.evaluatedAt / 1000 / 86_400),
    proofStatus: result.proof?.status,
  };
}

/** Human-readable one-liner for a hardware wallet or a terminal. Never logged. */
export function approvalScreenText(intent: NormalizedIntent): string {
  const parts = [intent.summary];
  if (intent.counterparty) parts.push(`to ${intent.counterparty}`);
  parts.push(`worth ${displayUsdc(intent.notionalUSDC)}`);
  return parts.join('\n');
}
