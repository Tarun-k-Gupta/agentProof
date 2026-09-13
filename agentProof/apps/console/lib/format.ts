/**
 * Formatting.
 *
 * Every amount that arrives here is a decimal string of USDC base units. It is
 * never parsed into a Number: 2^53 is about 9 billion dollars at six decimals,
 * which is closer than anyone should be comfortable with, and the UNBOUNDED
 * sentinel is 2^255.
 */

/** The SDK's sentinel for an outflow that cannot be bounded. */
export const UNBOUNDED = 1n << 255n;

export function isUnbounded(amount: string | bigint): boolean {
  try {
    return BigInt(amount) >= UNBOUNDED;
  } catch {
    return false;
  }
}

/** `usdc('100250000')` → `'100.25'` */
export function usdc(amount: string | bigint, decimals = 6): string {
  let value: bigint;
  try {
    value = BigInt(amount);
  } catch {
    return '—';
  }
  if (value >= UNBOUNDED) return 'UNBOUNDED';

  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = (absolute / scale).toLocaleString('en-US');
  const cents = ((absolute % scale) / 10n ** BigInt(decimals - 2)).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${cents}`;
}

/** Same, with the unit, and the sentinel rendered as words rather than digits. */
export function usdcLabel(amount: string | bigint): string {
  return isUnbounded(amount) ? 'an UNBOUNDED amount' : `${usdc(amount)} USDC`;
}

export function shortAddress(address?: string): string {
  if (!address) return '—';
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function shortHash(hash?: string): string {
  if (!hash) return '—';
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

export function percent(spent: string, limit: string): number {
  try {
    const s = BigInt(spent);
    const l = BigInt(limit);
    if (l <= 0n) return 0;
    if (s >= l) return 100;
    // Percent to one decimal, computed in integer space.
    return Number((s * 1000n) / l) / 10;
  } catch {
    return 0;
  }
}

export function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export const SEPOLIA_EXPLORER = 'https://sepolia.etherscan.io';
