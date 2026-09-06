import type { Address, Hex } from '../core/types.ts';

/**
 * The narrow slice of ABI decoding the SDK needs.
 *
 * Deliberately small: decoders only ever read static head words and packed
 * address/uint arguments out of known selectors. Anything more exotic is
 * classified UNKNOWN and blocked, which is the correct outcome — a decoder that
 * tries to understand everything is a decoder you cannot reason about.
 */

export function isHex(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value);
}

export function assertHex(value: unknown, label = 'value'): Hex {
  if (!isHex(value)) throw new Error(`${label} is not 0x-prefixed hex: ${String(value)}`);
  return value;
}

export function hexToBytes(hex: Hex): Uint8Array {
  const body = hex.slice(2);
  if (body.length % 2 !== 0) throw new Error('Hex string has an odd length');
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): Hex {
  let hex = '0x';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex as Hex;
}

/** First four bytes of calldata. Returns '0x' for empty data. */
export function selectorOf(data: Hex): Hex {
  return (data.length >= 10 ? data.slice(0, 10) : '0x') as Hex;
}

/** Number of 32-byte argument words after the selector. */
export function wordCount(data: Hex): number {
  return Math.floor((data.length - 10) / 64);
}

/** Reads the nth 32-byte word after the selector as a bigint. */
export function readWord(data: Hex, index: number): bigint {
  const start = 10 + index * 64;
  const word = data.slice(start, start + 64);
  if (word.length !== 64) throw new Error(`Calldata too short for word ${index}`);
  return BigInt(`0x${word}`);
}

/** Reads the nth 32-byte word as a left-padded address. */
export function readAddress(data: Hex, index: number): Address {
  const value = readWord(data, index);
  return normalizeAddress(`0x${value.toString(16).padStart(40, '0')}`);
}

/**
 * Lowercases an address for set membership.
 * @remarks Allowlists are compared case-insensitively on purpose. A checksum
 *          mismatch silently failing an allowlist lookup would be a policy
 *          bypass dressed up as a typo.
 */
export function normalizeAddress(value: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`Not an address: ${value}`);
  return value.toLowerCase() as Address;
}

export function addressSet(values: readonly string[]): ReadonlySet<Address> {
  return new Set(values.map(normalizeAddress));
}

export const UINT256_MAX = (1n << 256n) - 1n;

/** Heuristic for "unlimited" approvals: uint256 max and the common uint96 sentinels. */
export function isUnlimitedApproval(amount: bigint): boolean {
  return amount >= (1n << 128n) - 1n;
}
