import type { Action, NormalizedIntent } from '../core/types.ts';
import { NATIVE_ASSET } from '../core/types.ts';
import { normalizeAddress } from '../utils/hex.ts';
import type { DecoderContext, SelectorDecoder } from './registry.ts';

/**
 * Plain value transfers: empty calldata, non-zero value.
 *
 * Registered as a wildcard because a bare send has no selector to key on.
 * Native value does not contribute to `notionalUSDC` — we bound one asset and
 * say so — but it is still surfaced in `outflow` so the allowlist and the
 * human-approval screen see it.
 */
export const nativeDecoder: SelectorDecoder = {
  name: 'native',
  selectors: ['*'],

  decode(action: Action, _ctx: DecoderContext): NormalizedIntent | undefined {
    const hasCalldata = action.data.length > 2;
    if (hasCalldata || action.value === 0n) return undefined;

    const to = normalizeAddress(action.to);
    return {
      kind: 'NATIVE_TRANSFER',
      target: to,
      selector: '0x',
      nativeValue: action.value,
      outflow: [{ asset: NATIVE_ASSET, amount: action.value, provenance: 'DECODED' }],
      counterparty: to,
      notionalUSDC: 0n,
      summary: `Send ${action.value} wei to ${to}`,
      raw: action,
    };
  },
};
