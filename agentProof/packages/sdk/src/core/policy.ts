import type { Address, Hex, PolicyDocument, ResolvedPolicy } from './types.ts';
import { keccak256 } from '../crypto/keccak.ts';
import { addressSet, normalizeAddress } from '../utils/hex.ts';
import { parsePolicyAmount } from '../utils/units.ts';

/**
 * Canonical JSON serialisation.
 *
 * The policy hash is compared across three systems — a local file, an ENS text
 * record and a mapping in a Solidity contract. Any of them re-serialising with
 * different key order or whitespace would break the binding, so serialisation
 * is pinned here: keys sorted lexicographically at every level, no whitespace,
 * no trailing newline, UTF-8.
 *
 * Deliberately not JSON.stringify's default: object key order in JavaScript is
 * insertion order, which means a hash that depends on how the file was edited.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJSON(v)}`).join(',')}}`;
}

/**
 * keccak256 of the canonical policy JSON.
 *
 * This value is: stored on-chain in the hook at install time, published as the
 * `agentproof.policy` ENS text record, and checked by the SDK at startup. If
 * the three disagree, the agent does not start. That three-way binding is what
 * makes the identity layer load-bearing rather than decorative — it is the
 * reason a tampered local policy file cannot quietly widen an agent's limits.
 */
export function policyHash(document: PolicyDocument): Hex {
  return keccak256(canonicalJSON(document));
}

/** Type-checks and normalises a policy document at authoring time. */
export function definePolicy(document: PolicyDocument): PolicyDocument {
  return document;
}

export class PolicyValidationError extends Error {
  constructor(message: string) {
    super(`Invalid policy: ${message}`);
    this.name = 'PolicyValidationError';
  }
}

/**
 * Parses a policy document into the bigint-typed form the engine uses.
 *
 * Validation is strict and fails loudly. A policy file is a security control;
 * silently coercing a malformed one into something runnable is how a limit ends
 * up being zero, or absent, in production.
 */
export function resolvePolicy(document: PolicyDocument): ResolvedPolicy {
  if (document.version !== 'agentproof/v1') {
    throw new PolicyValidationError(`unsupported version ${String(document.version)}`);
  }
  if (!document.asset?.address) throw new PolicyValidationError('asset.address is required');
  if (document.asset.decimals !== 6) {
    throw new PolicyValidationError(
      `asset.decimals must be 6 in the MVP (got ${document.asset.decimals}); ` +
        'multi-decimal accounting requires the price-oracle work listed as future work',
    );
  }

  const amount = (key: keyof PolicyDocument['policies']): bigint => {
    const raw = document.policies[key];
    if (typeof raw !== 'string') throw new PolicyValidationError(`policies.${String(key)} must be a decimal string`);
    const value = parsePolicyAmount(raw, document.asset.decimals);
    if (value < 0n) throw new PolicyValidationError(`policies.${String(key)} must not be negative`);
    return value;
  };

  const maxTransaction = amount('maxTransaction');
  const dailySpend = amount('dailySpend');
  const approvalThreshold = amount('approvalThreshold');
  const minBalance = amount('minBalance');

  if (maxTransaction === 0n) throw new PolicyValidationError('maxTransaction of 0 blocks everything; set a real limit');
  if (dailySpend < maxTransaction) {
    throw new PolicyValidationError(
      `dailySpend (${dailySpend}) is below maxTransaction (${maxTransaction}), which makes the ` +
        'per-transaction limit unreachable and is almost always a units mistake',
    );
  }
  if (approvalThreshold > maxTransaction) {
    throw new PolicyValidationError(
      `approvalThreshold (${approvalThreshold}) is above maxTransaction (${maxTransaction}), so no action ` +
        'could ever reach a human — it would be blocked first',
    );
  }

  const allowedContracts = document.policies.allowedContracts ?? [];
  if (allowedContracts.length === 0) {
    throw new PolicyValidationError('allowedContracts is empty, which blocks every action');
  }

  return {
    document,
    hash: policyHash(document),
    maxTransaction,
    dailySpend,
    approvalThreshold,
    minBalance,
    allowedContracts: addressSet([...allowedContracts, document.asset.address]),
    allowedRecipients: addressSet(document.policies.allowedRecipients ?? []),
    asset: normalizeAddress(document.asset.address),
    decimals: document.asset.decimals,
    account: normalizeAddress(document.enforcement.account),
    hook: normalizeAddress(document.enforcement.hook),
  };
}

export type { PolicyDocument, ResolvedPolicy } from './types.ts';
export type { Address };
