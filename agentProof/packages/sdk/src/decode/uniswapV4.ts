import type { Action, Address, NormalizedIntent } from '../core/types.ts';
import { displayUsdc, UNBOUNDED } from '../utils/units.ts';
import { normalizeAddress, readWord, selectorOf } from '../utils/hex.ts';
import type { DecoderContext, SelectorDecoder } from './registry.ts';

/** execute(bytes commands, bytes[] inputs) and its deadline variant. */
export const SELECTOR_EXECUTE = '0x3593564c';
export const SELECTOR_EXECUTE_NO_DEADLINE = '0x24856bc3';

/**
 * Universal Router command bytes (low 5 bits of each command byte).
 * Only the commands that can move value out of the account are listed; the
 * rest are irrelevant to a spend limit.
 */
const Command = {
  V3_SWAP_EXACT_IN: 0x00,
  V3_SWAP_EXACT_OUT: 0x01,
  PERMIT2_TRANSFER_FROM: 0x02,
  SWEEP: 0x04,
  TRANSFER: 0x05,
  PAY_PORTION: 0x06,
  V2_SWAP_EXACT_IN: 0x08,
  V2_SWAP_EXACT_OUT: 0x09,
  V4_SWAP: 0x10,
} as const;

/**
 * Decodes a Universal Router command stream to a worst-case outflow.
 *
 * This decoder is the actual reusable contribution to the Uniswap ecosystem:
 * it is what makes v4 calldata policy-checkable at all. Exported standalone as
 * `@agentproof/sdk/decode/uniswap` so other agent tooling can use it without
 * adopting the rest of AgentProof.
 *
 * Two rules govern everything here:
 *
 *   1. For an exact-output swap, the outflow is `amountInMaximum`, never the
 *      quoted amount. The quote is what you hope to pay; the maximum is what
 *      you have authorised the router to take.
 *   2. Any command we cannot decode makes the whole stream unbounded. A swap
 *      bundled with one unreadable command is an unreadable swap.
 */
export const uniswapV4Decoder: SelectorDecoder = {
  name: 'uniswapV4',
  selectors: [SELECTOR_EXECUTE, SELECTOR_EXECUTE_NO_DEADLINE],

  decode(action: Action, ctx: DecoderContext): NormalizedIntent | undefined {
    const selector = selectorOf(action.data);
    const router = normalizeAddress(action.to);

    let stream: { commands: number[]; inputs: string[] };
    try {
      stream = readCommandStream(action.data, selector === SELECTOR_EXECUTE);
    } catch {
      return unboundedSwap(action, router, selector, ctx.trackedAsset, 'command stream is malformed');
    }

    let maxInput = 0n;
    let recipient: Address | undefined;

    for (let i = 0; i < stream.commands.length; i++) {
      const command = stream.commands[i] & 0x1f;
      const input = stream.inputs[i];
      if (input === undefined) {
        return unboundedSwap(action, router, selector, ctx.trackedAsset, 'input missing for a command');
      }

      switch (command) {
        case Command.V3_SWAP_EXACT_IN:
        case Command.V2_SWAP_EXACT_IN: {
          // (recipient, amountIn, amountOutMin, path, payerIsUser)
          recipient ??= wordAsAddress(input, 0);
          maxInput += wordAt(input, 1);
          break;
        }
        case Command.V3_SWAP_EXACT_OUT:
        case Command.V2_SWAP_EXACT_OUT: {
          // (recipient, amountOut, amountInMaximum, path, payerIsUser)
          recipient ??= wordAsAddress(input, 0);
          maxInput += wordAt(input, 2); // the maximum, never the quote
          break;
        }
        case Command.V4_SWAP: {
          // v4 actions are themselves a nested (bytes actions, bytes[] params)
          // stream. The settle action carries amountInMaximum in its second
          // word; anything we cannot resolve makes the stream unbounded.
          const settled = readV4MaxInput(input);
          if (settled === undefined) {
            return unboundedSwap(action, router, selector, ctx.trackedAsset, 'v4 action stream is not decodable');
          }
          maxInput += settled;
          break;
        }
        case Command.TRANSFER:
        case Command.PERMIT2_TRANSFER_FROM: {
          // (token, recipient, amount)
          recipient ??= wordAsAddress(input, 1);
          maxInput += wordAt(input, 2);
          break;
        }
        case Command.PAY_PORTION:
        case Command.SWEEP:
          // Move residue, never principal. No additional outflow.
          break;
        default:
          return unboundedSwap(
            action,
            router,
            selector,
            ctx.trackedAsset,
            `command 0x${command.toString(16)} is not decodable`,
          );
      }
    }

    return {
      kind: 'SWAP',
      target: router,
      selector,
      nativeValue: action.value,
      outflow: [{ asset: ctx.trackedAsset, amount: maxInput, provenance: 'DECODED' }],
      counterparty: recipient ?? router,
      notionalUSDC: maxInput,
      summary: `Swap up to ${displayUsdc(maxInput)} via Universal Router`,
      raw: action,
    };
  },
};

// ---------------------------------------------------------------- internals

function unboundedSwap(
  action: Action,
  router: Address,
  selector: `0x${string}`,
  asset: Address,
  why: string,
): NormalizedIntent {
  return {
    kind: 'UNKNOWN',
    target: router,
    selector,
    nativeValue: action.value,
    outflow: [{ asset, amount: UNBOUNDED, provenance: 'DECLARED' }],
    counterparty: router,
    notionalUSDC: UNBOUNDED,
    summary: `Router call could not be bounded: ${why}`,
    raw: action,
  };
}

/** Reads the (bytes commands, bytes[] inputs) head of an execute() call. */
function readCommandStream(data: `0x${string}`, hasDeadline: boolean): { commands: number[]; inputs: string[] } {
  const body = data.slice(10);
  const word = (index: number) => BigInt(`0x${body.slice(index * 64, index * 64 + 64)}`);
  const at = (byteOffset: bigint) => Number(byteOffset) * 2;

  const commandsOffset = at(word(0));
  const inputsOffset = at(word(1));
  if (hasDeadline) void word(2); // deadline, not policy-relevant

  const commandsLength = Number(BigInt(`0x${body.slice(commandsOffset, commandsOffset + 64)}`));
  const commandsHex = body.slice(commandsOffset + 64, commandsOffset + 64 + commandsLength * 2);
  const commands: number[] = [];
  for (let i = 0; i < commandsLength; i++) commands.push(parseInt(commandsHex.slice(i * 2, i * 2 + 2), 16));

  const inputsLength = Number(BigInt(`0x${body.slice(inputsOffset, inputsOffset + 64)}`));
  const inputs: string[] = [];
  for (let i = 0; i < inputsLength; i++) {
    const relative = Number(BigInt(`0x${body.slice(inputsOffset + 64 + i * 64, inputsOffset + 128 + i * 64)}`)) * 2;
    const start = inputsOffset + 64 + relative;
    const length = Number(BigInt(`0x${body.slice(start, start + 64)}`));
    inputs.push(body.slice(start + 64, start + 64 + length * 2));
  }

  if (commands.length !== inputs.length) {
    throw new Error('commands and inputs length mismatch');
  }
  return { commands, inputs };
}

function wordAt(input: string, index: number): bigint {
  const word = input.slice(index * 64, index * 64 + 64);
  if (word.length !== 64) throw new Error(`input too short for word ${index}`);
  return BigInt(`0x${word}`);
}

function wordAsAddress(input: string, index: number): Address {
  const value = wordAt(input, index);
  return normalizeAddress(`0x${value.toString(16).padStart(40, '0')}`);
}

/**
 * v4 `(bytes actions, bytes[] params)`: sums the amountInMaximum of every
 * SETTLE / SWAP_EXACT_OUT action. Returns undefined when the stream contains an
 * action we do not model, which the caller turns into an unbounded intent.
 */
const V4Action = { SWAP_EXACT_IN_SINGLE: 0x06, SWAP_EXACT_OUT_SINGLE: 0x08, SETTLE: 0x0b, TAKE: 0x0c } as const;

function readV4MaxInput(input: string): bigint | undefined {
  try {
    const inner = readCommandStream(`0x00000000${input}` as `0x${string}`, false);
    let total = 0n;
    for (let i = 0; i < inner.commands.length; i++) {
      const action = inner.commands[i];
      const params = inner.inputs[i];
      if (action === V4Action.SWAP_EXACT_IN_SINGLE) total += wordAt(params, 1);
      else if (action === V4Action.SWAP_EXACT_OUT_SINGLE) total += wordAt(params, 2);
      else if (action === V4Action.SETTLE || action === V4Action.TAKE) continue;
      else return undefined;
    }
    return total;
  } catch {
    return undefined;
  }
}
