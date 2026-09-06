import type { Action, NormalizedIntent } from '../core/types.ts';
import { displayUsdc } from '../utils/units.ts';
import { normalizeAddress, readAddress, readWord, selectorOf } from '../utils/hex.ts';
import type { DecoderContext, SelectorDecoder } from './registry.ts';

/**
 * x402 payment payloads.
 *
 * The point of routing payments through the same decoder as swaps is that the
 * same policy governs both. An agent paying $0.01 for a data query and an agent
 * swapping $250 are the same kind of event to AgentProof: value leaving the
 * account toward a counterparty, bounded by the same numbers.
 *
 * On Hedera the settlement is an HTS transfer built by the facilitator from a
 * partially-signed transaction. The SDK sees it as a transfer of the tracked
 * asset to the service's payTo account, tagged X402_PAYMENT so the dashboard
 * and the HCS audit trail can distinguish a paid API call from a trade.
 */

// settle(address token, address payTo, uint256 amount, bytes32 requestId)
export const SELECTOR_X402_SETTLE = '0xd4729c72';

export const x402Decoder: SelectorDecoder = {
  name: 'x402',
  selectors: [SELECTOR_X402_SETTLE],

  decode(action: Action, ctx: DecoderContext): NormalizedIntent | undefined {
    const selector = selectorOf(action.data);
    if (selector !== SELECTOR_X402_SETTLE) return undefined;

    const token = readAddress(action.data, 0);
    const payTo = readAddress(action.data, 1);
    const amount = readWord(action.data, 2);

    return {
      kind: 'X402_PAYMENT',
      target: normalizeAddress(action.to),
      selector,
      nativeValue: action.value,
      outflow: [{ asset: token, amount, provenance: 'DECODED' }],
      counterparty: payTo,
      notionalUSDC: token === ctx.trackedAsset ? amount : 0n,
      summary: `Pay ${displayUsdc(amount)} for a metered API call to ${payTo}`,
      raw: action,
    };
  },
};

/**
 * Builds the Action an agent proposes when answering a 402 challenge, so the
 * payment is policy-checked before it is signed rather than after.
 */
export function x402PaymentAction(params: {
  facilitator: `0x${string}`;
  token: `0x${string}`;
  payTo: `0x${string}`;
  amount: bigint;
  requestId: `0x${string}`;
  chainId: number;
}): Action {
  const word = (value: bigint) => value.toString(16).padStart(64, '0');
  const data =
    SELECTOR_X402_SETTLE +
    word(BigInt(params.token)) +
    word(BigInt(params.payTo)) +
    word(params.amount) +
    params.requestId.slice(2).padStart(64, '0');

  return {
    to: params.facilitator,
    data: data as `0x${string}`,
    value: 0n,
    chainId: params.chainId,
    metadata: { kind: 'x402', requestId: params.requestId },
  };
}
