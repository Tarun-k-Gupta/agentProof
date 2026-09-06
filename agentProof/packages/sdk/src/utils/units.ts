/**
 * Units.
 *
 * Every policy value in this codebase is in USDC base units (6 decimals).
 * `100n` is one ten-thousandth of a cent and is almost always a bug. Use
 * `usdc(100)`.
 */

/**
 * The sentinel for an outflow we cannot bound: an unlimited approval, or
 * calldata we could not decode.
 *
 * Chosen as 2^255 rather than uint256 max so that summing several unbounded
 * outflows cannot overflow a uint256 in downstream arithmetic. Any real amount
 * is astronomically below it, so a comparison against a policy limit gives the
 * right answer — but it is a sentinel, and it is rendered as one rather than as
 * a 76-digit quantity of dollars.
 */
export const UNBOUNDED = 1n << 255n;

export function isUnbounded(amount: bigint): boolean {
  return amount >= UNBOUNDED;
}

export const USDC_DECIMALS = 6;
const USDC_SCALE = 10n ** BigInt(USDC_DECIMALS);

/** usdc(100) === 100_000_000n */
export function usdc(whole: number | string): bigint {
  return parsePolicyAmount(String(whole));
}

/**
 * Parses a decimal string into USDC base units without going through a float.
 * `parsePolicyAmount('100.25') === 100_250_000n`
 */
export function parsePolicyAmount(value: string, decimals = USDC_DECIMALS): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid policy amount: ${JSON.stringify(value)}`);
  }
  const negative = trimmed.startsWith('-');
  const [whole, fraction = ''] = (negative ? trimmed.slice(1) : trimmed).split('.');
  if (fraction.length > decimals) {
    throw new Error(`Amount ${value} has more precision than ${decimals} decimals allows`);
  }
  const scaled = BigInt(whole + fraction.padEnd(decimals, '0'));
  return negative ? -scaled : scaled;
}

export function parseBaseUnitPolicyAmount(value: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) throw new Error(`Invalid base-unit policy amount: ${JSON.stringify(value)}`);
  if (/^[1-9]\d{0,5}$/.test(trimmed)) {
    throw new Error(
      `Policy amount ${JSON.stringify(value)} looks like an old display-unit value. ` +
        'The PRD schema stores USDC base units; use "100000000" for 100 USDC.',
    );
  }
  return BigInt(trimmed);
}

/** formatUsdc(100_250_000n) === '100.25' */
export function formatUsdc(amount: bigint, decimals = USDC_DECIMALS): string {
  const scale = 10n ** BigInt(decimals);
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  const body = fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
  return negative ? `-${body}` : body;
}

/** Display form used in logs, the dashboard and hardware-wallet screens. */
export function displayUsdc(amount: bigint): string {
  if (isUnbounded(amount)) return 'an UNBOUNDED amount';
  const scale = USDC_SCALE;
  const whole = amount / scale;
  const cents = ((amount % scale) / 10_000n).toString().padStart(2, '0');
  return `${whole.toLocaleString('en-US')}.${cents} USDC`;
}

export const UTC_DAY_SECONDS = 86_400;

/** The UTC-day bucket a timestamp (in ms) falls into. Mirrors the hook exactly. */
export function utcDay(timestampMs: number): number {
  return Math.floor(timestampMs / 1000 / UTC_DAY_SECONDS);
}
