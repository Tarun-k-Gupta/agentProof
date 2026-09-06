import type { Action, NormalizedIntent } from '../core/types.ts';
import { displayUsdc, UNBOUNDED } from '../utils/units.ts';
import { isUnlimitedApproval, normalizeAddress, readAddress, readWord, selectorOf } from '../utils/hex.ts';
import type { DecoderContext, SelectorDecoder } from './registry.ts';

export const SELECTOR_TRANSFER = '0xa9059cbb'; // transfer(address,uint256)
export const SELECTOR_TRANSFER_FROM = '0x23b872dd'; // transferFrom(address,address,uint256)
export const SELECTOR_APPROVE = '0x095ea7b3'; // approve(address,uint256)
export const SELECTOR_INCREASE_ALLOWANCE = '0x39509351'; // increaseAllowance(address,uint256)
export const SELECTOR_PERMIT2_APPROVE = '0x87517c45'; // approve(address,address,uint160,uint48)

/**
 * The rule that catches threat T4.
 *
 * An approval's outflow is the FULL approved allowance, not zero and not the
 * amount the agent says it intends to spend. An approval is a standing licence
 * to move funds; treating it as costing nothing is how "approve 10, drain
 * everything" gets through a policy check.
 *
 * An unlimited approval is therefore an unlimited outflow, which no finite
 * limit can accommodate, so it always blocks.
 */
function approvalOutflow(amount: bigint): bigint {
  return isUnlimitedApproval(amount) ? UNBOUNDED : amount;
}

export const erc20Decoder: SelectorDecoder = {
  name: 'erc20',
  selectors: [
    SELECTOR_TRANSFER,
    SELECTOR_TRANSFER_FROM,
    SELECTOR_APPROVE,
    SELECTOR_INCREASE_ALLOWANCE,
    SELECTOR_PERMIT2_APPROVE,
  ],

  decode(action: Action, ctx: DecoderContext): NormalizedIntent | undefined {
    const selector = selectorOf(action.data);
    const asset = normalizeAddress(action.to);

    // Only the tracked asset produces a notional figure. Other tokens still
    // decode (so the allowlist can see the counterparty) but contribute no
    // notional, because we have no oracle. See docs/threat-model.md gap 2.
    const tracked = asset === ctx.trackedAsset;

    switch (selector) {
      case SELECTOR_TRANSFER: {
        const to = readAddress(action.data, 0);
        const amount = readWord(action.data, 1);
        return {
          kind: 'TRANSFER',
          target: asset,
          selector,
          nativeValue: action.value,
          outflow: [{ asset, amount, provenance: 'DECODED' }],
          counterparty: to,
          notionalUSDC: tracked ? amount : 0n,
          summary: `Send ${displayUsdc(amount)} to ${to}`,
          raw: action,
        };
      }

      case SELECTOR_TRANSFER_FROM: {
        const from = readAddress(action.data, 0);
        const to = readAddress(action.data, 1);
        const amount = readWord(action.data, 2);
        // Only counts as our outflow when the funds leave our account.
        const leavesUs = from === ctx.account;
        return {
          kind: 'TRANSFER',
          target: asset,
          selector,
          nativeValue: action.value,
          outflow: leavesUs ? [{ asset, amount, provenance: 'DECODED' }] : [],
          counterparty: to,
          notionalUSDC: tracked && leavesUs ? amount : 0n,
          summary: `Pull ${displayUsdc(amount)} from ${from} to ${to}`,
          raw: action,
        };
      }

      case SELECTOR_APPROVE:
      case SELECTOR_INCREASE_ALLOWANCE: {
        const spender = readAddress(action.data, 0);
        const allowance = readWord(action.data, 1);
        const worstCase = approvalOutflow(allowance);
        const unlimited = isUnlimitedApproval(allowance);
        return {
          kind: 'APPROVE',
          target: asset,
          selector,
          nativeValue: action.value,
          outflow: [{ asset, amount: worstCase, provenance: 'DECODED' }],
          counterparty: spender,
          notionalUSDC: tracked ? worstCase : 0n,
          summary: unlimited
            ? `Grant UNLIMITED spending approval to ${spender}`
            : `Approve ${displayUsdc(allowance)} of spending to ${spender}`,
          raw: action,
        };
      }

      case SELECTOR_PERMIT2_APPROVE: {
        // approve(address token, address spender, uint160 amount, uint48 expiration)
        const token = readAddress(action.data, 0);
        const spender = readAddress(action.data, 1);
        const allowance = readWord(action.data, 2);
        const worstCase = approvalOutflow(allowance);
        return {
          kind: 'APPROVE',
          target: asset,
          selector,
          nativeValue: action.value,
          outflow: [{ asset: token, amount: worstCase, provenance: 'DECODED' }],
          counterparty: spender,
          notionalUSDC: token === ctx.trackedAsset ? worstCase : 0n,
          summary: `Permit2 approve ${displayUsdc(allowance)} to ${spender}`,
          raw: action,
        };
      }

      default:
        return undefined;
    }
  },
};
