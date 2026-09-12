/**
 * USDC display ⇄ base-unit conversion, for the policy settings form only.
 *
 * `agent.policy.json` and the wire contract of PUT /v1/policy both store base
 * units ("100000000" for 100 USDC) — see resolvePolicy in @agentproof/sdk. A
 * developer typing a limit should never have to do that arithmetic by hand,
 * but this file does not import the SDK: everything that crosses the API
 * boundary here is a plain string, on purpose (see lib/types.ts), so the
 * conversion is reimplemented in the same few lines rather than pulled in.
 */

const DECIMALS = 6;
const SCALE = 10n ** BigInt(DECIMALS);

export class AmountError extends Error {}

/** toBaseUnits("100.5") === "100500000" */
export function toBaseUnits(display: string): string {
  const trimmed = display.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new AmountError(`"${display}" is not a non-negative number`);
  }
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > DECIMALS) {
    throw new AmountError(`"${display}" has more than ${DECIMALS} decimal places`);
  }
  return (BigInt(whole) * SCALE + BigInt(fraction.padEnd(DECIMALS, '0') || '0')).toString();
}

/** toDisplay("100500000") === "100.5" */
export function toDisplay(baseUnits: string): string {
  if (!/^\d+$/.test(baseUnits)) return baseUnits;
  const value = BigInt(baseUnits);
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}

/** One address per line or comma-separated; blank lines and surrounding whitespace ignored. */
export function parseAddressList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isAddress(value: string): boolean {
  return ADDRESS_RE.test(value);
}
