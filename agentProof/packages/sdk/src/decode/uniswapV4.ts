import { NATIVE_ASSET } from '../core/types.ts';
import type { Action, Address, NormalizedIntent, Provenance } from '../core/types.ts';
import { displayUsdc, UNBOUNDED } from '../utils/units.ts';
import { normalizeAddress, selectorOf } from '../utils/hex.ts';
import type { DecoderContext, SelectorDecoder } from './registry.ts';

/** execute(bytes commands, bytes[] inputs) and its deadline variant. */
export const SELECTOR_EXECUTE = '0x3593564c';
export const SELECTOR_EXECUTE_NO_DEADLINE = '0x24856bc3';

/**
 * Currency(0) is native ETH throughout v4 and the Universal Router.
 *
 * Reported to callers as the SDK's `NATIVE_ASSET` sentinel rather than as the
 * zero address, so one asset has one identity everywhere in an intent. v4's
 * encoding is an implementation detail of v4.
 */
const V4_NATIVE_CURRENCY = '0x0000000000000000000000000000000000000000' as Address;
export const NATIVE = NATIVE_ASSET;

/**
 * Universal Router command byte layout.
 *
 * The top two bits are flags — 0x80 allows the command to revert without
 * reverting the batch — and the command type is the low six bits. Masking with
 * 0x1f instead (an easy mistake, since every command in the first release fit
 * in five bits) silently folds command 0x20+ onto a different command's
 * decoder, which is the worst possible failure for a bound: it produces a
 * confident wrong number rather than an honest UNBOUNDED.
 */
const COMMAND_TYPE_MASK = 0x3f;

/**
 * Permit2 stores allowances in a uint160, so max-uint160 is its "unlimited"
 * sentinel — the Permit2 equivalent of an unlimited ERC-20 approval, and the
 * value real Universal Router traffic actually uses.
 */
const PERMIT2_UNLIMITED = (1n << 160n) - 1n;

const Command = {
  V3_SWAP_EXACT_IN: 0x00,
  V3_SWAP_EXACT_OUT: 0x01,
  PERMIT2_TRANSFER_FROM: 0x02,
  SWEEP: 0x04,
  TRANSFER: 0x05,
  PAY_PORTION: 0x06,
  V2_SWAP_EXACT_IN: 0x08,
  V2_SWAP_EXACT_OUT: 0x09,
  PERMIT2_PERMIT: 0x0a,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
  V4_SWAP: 0x10,
} as const;

/**
 * v4 router action bytes, from v4-periphery's `Actions` library.
 *
 * Worth stating explicitly because an off-by-one here is invisible in tests
 * built on our own encoder and fatal against real calldata: SETTLE is 0x0b,
 * SETTLE_ALL is 0x0c, TAKE is 0x0e and TAKE_ALL is 0x0f. Every real v4 swap on
 * Sepolia ends in a TAKE_ALL, so a decoder that does not know 0x0f cannot bound
 * a single live transaction.
 */
const V4Action = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SWAP_EXACT_IN: 0x07,
  SWAP_EXACT_OUT_SINGLE: 0x08,
  SWAP_EXACT_OUT: 0x09,
  SETTLE: 0x0b,
  SETTLE_ALL: 0x0c,
  SETTLE_PAIR: 0x0d,
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
  TAKE_PORTION: 0x10,
  TAKE_PAIR: 0x11,
  CLOSE_CURRENCY: 0x12,
  CLEAR_OR_TAKE: 0x13,
} as const;

/**
 * Decodes a Universal Router command stream to a worst-case outflow, per asset.
 *
 * This decoder is the actual reusable contribution to the Uniswap ecosystem: it
 * is what makes v4 calldata policy-checkable at all. Exported standalone as
 * `@agentproof/sdk/decode/uniswap` so other agent tooling can use it without
 * adopting the rest of AgentProof.
 *
 * Three rules govern everything here:
 *
 *   1. For an exact-output swap the outflow is `amountInMaximum`, never the
 *      quoted amount. The quote is what you hope to pay; the maximum is what
 *      you have authorised the router to take.
 *   2. Amounts are attributed to the currency that actually leaves, not to
 *      whichever asset the policy happens to track. A 3 ETH swap is not three
 *      dollars of USDC, and summing across currencies as if they were one unit
 *      is how a spend limit ends up meaning nothing.
 *   3. Any command or action we cannot decode makes the whole stream unbounded.
 *      A swap bundled with one unreadable command is an unreadable swap.
 */
export const uniswapV4Decoder: SelectorDecoder = {
  name: 'uniswapV4',
  selectors: [SELECTOR_EXECUTE, SELECTOR_EXECUTE_NO_DEADLINE],

  decode(action: Action, ctx: DecoderContext): NormalizedIntent | undefined {
    const selector = selectorOf(action.data);
    const router = normalizeAddress(action.to);
    const fail = (why: string) => unboundedSwap(action, router, selector, ctx.trackedAsset, why);

    let stream: { commands: number[]; inputs: string[] };
    try {
      stream = readCommandStream(action.data, selector === SELECTOR_EXECUTE);
    } catch {
      return fail('command stream is malformed');
    }

    const outflow = new Outflow();
    let recipient: Address | undefined;

    for (let i = 0; i < stream.commands.length; i++) {
      const command = stream.commands[i] & COMMAND_TYPE_MASK;
      const input = stream.inputs[i];
      if (input === undefined) return fail('input missing for a command');

      try {
        switch (command) {
          case Command.V3_SWAP_EXACT_IN:
          case Command.V2_SWAP_EXACT_IN: {
            // (recipient, amountIn, amountOutMin, path, payerIsUser)
            recipient ??= wordAsAddress(input, 0);
            const currency = pathFirstToken(input, 3);
            if (currency === undefined) return fail('swap path is not decodable');
            outflow.add(currency, wordAt(input, 1));
            break;
          }
          case Command.V3_SWAP_EXACT_OUT:
          case Command.V2_SWAP_EXACT_OUT: {
            // (recipient, amountOut, amountInMaximum, path, payerIsUser).
            // An exact-output path is stored reversed — output token first — so
            // the token we pay with is the last hop, not the first.
            recipient ??= wordAsAddress(input, 0);
            const currency = pathLastToken(input, 3);
            if (currency === undefined) return fail('swap path is not decodable');
            outflow.add(currency, wordAt(input, 2)); // the maximum, never the quote
            break;
          }
          case Command.V4_SWAP: {
            const nested = readV4Outflow(input);
            if (nested === undefined) return fail('v4 action stream is not decodable');
            outflow.merge(nested);
            break;
          }
          case Command.TRANSFER:
          case Command.PERMIT2_TRANSFER_FROM: {
            // (token, recipient, amount)
            recipient ??= wordAsAddress(input, 1);
            outflow.add(wordAsAddress(input, 0), wordAt(input, 2));
            break;
          }
          case Command.PERMIT2_PERMIT: {
            // (PermitSingle{(token, amount, expiration, nonce), spender,
            // sigDeadline}, bytes signature). A permit is a standing licence to
            // move funds, so its worst case is the whole allowance — the same
            // rule the ERC-20 decoder applies to approve().
            const allowance = wordAt(input, 1);
            outflow.add(wordAsAddress(input, 0), allowance >= PERMIT2_UNLIMITED ? UNBOUNDED : allowance);
            break;
          }
          case Command.WRAP_ETH: {
            // (recipient, amount) — native ETH leaves to become WETH.
            outflow.add(NATIVE_ASSET, wordAt(input, 1));
            break;
          }
          case Command.UNWRAP_WETH:
          case Command.PAY_PORTION:
          case Command.SWEEP:
            // Unwrapping returns value to us; sweep and pay-portion move residue
            // rather than principal. No additional outflow.
            break;
          default:
            return fail(`command 0x${command.toString(16).padStart(2, '0')} is not decodable`);
        }
      } catch {
        return fail(`input for command 0x${command.toString(16).padStart(2, '0')} is malformed`);
      }
    }

    const tracked = outflow.get(ctx.trackedAsset);
    const native = outflow.get(NATIVE);
    const others = outflow.entries().filter(([asset]) => asset !== ctx.trackedAsset);

    return {
      kind: 'SWAP',
      target: router,
      selector,
      // The native value the caller attached is what the router may spend of it,
      // but a WRAP_ETH inside the stream can commit more than msg.value if the
      // router already holds a balance. Report the larger.
      nativeValue: native > action.value ? native : action.value,
      outflow: [
        { asset: ctx.trackedAsset, amount: tracked, provenance: 'DECODED' as Provenance },
        ...others.map(([asset, amount]) => ({ asset, amount, provenance: 'DECODED' as Provenance })),
      ],
      counterparty: recipient ?? router,
      // Only the tracked asset is denominated in the policy's unit. Outflow in
      // other currencies is reported above and left for a policy that
      // understands them, rather than being silently added to a USDC total.
      notionalUSDC: tracked,
      summary: summarise(tracked, others),
      raw: action,
    };
  },
};

// ---------------------------------------------------------------- internals

/** Per-currency worst-case outflow. */
class Outflow {
  private readonly byAsset = new Map<Address, bigint>();

  add(asset: Address, amount: bigint): void {
    const key = canonicalAsset(asset);
    this.byAsset.set(key, (this.byAsset.get(key) ?? 0n) + amount);
  }

  /**
   * Raises the bound for one currency without adding to it. Used for v4's
   * SETTLE_ALL, which caps what the preceding swaps may take rather than
   * authorising a further payment; adding it would double-count the swap.
   */
  atLeast(asset: Address, amount: bigint): void {
    const key = canonicalAsset(asset);
    const current = this.byAsset.get(key) ?? 0n;
    if (amount > current) this.byAsset.set(key, amount);
  }

  merge(other: Outflow): void {
    for (const [asset, amount] of other.byAsset) this.add(asset, amount);
  }

  get(asset: Address): bigint {
    return this.byAsset.get(canonicalAsset(asset)) ?? 0n;
  }

  entries(): Array<[Address, bigint]> {
    return [...this.byAsset].filter(([, amount]) => amount > 0n);
  }
}

/**
 * v4's zero-address native currency, normalised to the SDK's one sentinel.
 *
 * `NATIVE_ASSET` is EIP-55 mixed case, so it has to be recognised after
 * lowercasing too — otherwise a lookup keyed on the sentinel misses an entry
 * stored under its own lowercase form.
 */
const NATIVE_KEYS = new Set([V4_NATIVE_CURRENCY, NATIVE_ASSET.toLowerCase()]);

function canonicalAsset(asset: Address): Address {
  const normalised = normalizeAddress(asset);
  return NATIVE_KEYS.has(normalised.toLowerCase()) ? NATIVE_ASSET : normalised;
}

function summarise(tracked: bigint, others: Array<[Address, bigint]>): string {
  const parts: string[] = [];
  if (tracked > 0n) parts.push(`up to ${displayUsdc(tracked)}`);
  for (const [asset, amount] of others) {
    parts.push(`up to ${amount} base units of ${asset === NATIVE_ASSET ? 'native ETH' : asset}`);
  }
  if (parts.length === 0) return 'Router call with no outflow from this account';
  return `Swap ${parts.join(' and ')} via Universal Router`;
}

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
  if (commandsHex.length !== commandsLength * 2) throw new Error('commands run past the end of calldata');
  const commands: number[] = [];
  for (let i = 0; i < commandsLength; i++) commands.push(parseInt(commandsHex.slice(i * 2, i * 2 + 2), 16));

  const inputsLength = Number(BigInt(`0x${body.slice(inputsOffset, inputsOffset + 64)}`));
  const inputs: string[] = [];
  for (let i = 0; i < inputsLength; i++) {
    const relative = Number(BigInt(`0x${body.slice(inputsOffset + 64 + i * 64, inputsOffset + 128 + i * 64)}`)) * 2;
    const start = inputsOffset + 64 + relative;
    const length = Number(BigInt(`0x${body.slice(start, start + 64)}`));
    const element = body.slice(start + 64, start + 64 + length * 2);
    if (element.length !== length * 2) throw new Error('an input runs past the end of calldata');
    inputs.push(element);
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
 * A V2/V3 swap path is packed `token (20) [fee (3) token (20)]…`. `headIndex`
 * is the head word holding the offset to it.
 */
function readPath(input: string, headIndex: number): string | undefined {
  try {
    const offset = Number(wordAt(input, headIndex)) * 2;
    const length = Number(BigInt(`0x${input.slice(offset, offset + 64)}`));
    const path = input.slice(offset + 64, offset + 64 + length * 2);
    if (path.length !== length * 2 || length < 20) return undefined;
    return path;
  } catch {
    return undefined;
  }
}

function pathFirstToken(input: string, headIndex: number): Address | undefined {
  const path = readPath(input, headIndex);
  return path === undefined ? undefined : normalizeAddress(`0x${path.slice(0, 40)}`);
}

function pathLastToken(input: string, headIndex: number): Address | undefined {
  const path = readPath(input, headIndex);
  return path === undefined ? undefined : normalizeAddress(`0x${path.slice(path.length - 40)}`);
}

/**
 * v4 `(bytes actions, bytes[] params)`.
 *
 * Returns the per-currency worst case, or undefined when the stream contains an
 * action we do not model — which the caller turns into an unbounded intent.
 */
function readV4Outflow(input: string): Outflow | undefined {
  let inner: { commands: number[]; inputs: string[] };
  try {
    // The nested payload has the same (bytes, bytes[]) shape as execute(), so a
    // dummy selector lets one parser serve both.
    inner = readCommandStream(`0x00000000${input}` as `0x${string}`, false);
  } catch {
    return undefined;
  }

  const outflow = new Outflow();

  for (let i = 0; i < inner.commands.length; i++) {
    const action = inner.commands[i];
    const params = inner.inputs[i];

    try {
      switch (action) {
        case V4Action.SWAP_EXACT_IN_SINGLE: {
          // ExactInputSingleParams is a dynamic struct, so word 0 is an offset
          // into the params blob and the fields start at word 1:
          //   1 currency0  2 currency1  3 fee  4 tickSpacing  5 hooks
          //   6 zeroForOne 7 amountIn   8 amountOutMinimum
          const zeroForOne = wordAt(params, 6) !== 0n;
          outflow.add(wordAsAddress(params, zeroForOne ? 1 : 2), wordAt(params, 7));
          break;
        }
        case V4Action.SWAP_EXACT_OUT_SINGLE: {
          //   6 zeroForOne 7 amountOut 8 amountInMaximum
          const zeroForOne = wordAt(params, 6) !== 0n;
          outflow.add(wordAsAddress(params, zeroForOne ? 1 : 2), wordAt(params, 8));
          break;
        }
        case V4Action.SWAP_EXACT_IN:
        case V4Action.SWAP_EXACT_OUT:
          // Multi-hop. Deliberately refused rather than guessed.
          //
          // The single-hop layouts above are pinned against captured Sepolia
          // calldata (see tests/fixtures/uniswap-sepolia.json), and the
          // multi-hop ones are not: the routers we captured disagree with
          // v4-periphery's published `ExactInputParams` on where `amountIn`
          // sits, and reading the wrong word produced a bound that was off by
          // 640 base units while still looking entirely plausible. A confident
          // wrong number is worse than UNBOUNDED, which at least escalates to a
          // human. Modelling multi-hop is tracked in docs/future-work.md.
          return undefined;
        case V4Action.SETTLE: {
          // (currency, amount, payerIsUser). amount 0 is the OPEN_DELTA
          // sentinel — "whatever is owed" — which the swap actions already
          // account for.
          const payerIsUser = wordAt(params, 2) !== 0n;
          if (payerIsUser) outflow.add(wordAsAddress(params, 0), wordAt(params, 1));
          break;
        }
        case V4Action.SETTLE_ALL: {
          // (currency, maxAmount). This caps what the preceding swaps may take
          // rather than authorising a further payment.
          outflow.atLeast(wordAsAddress(params, 0), wordAt(params, 1));
          break;
        }
        case V4Action.SETTLE_PAIR:
          // Settles the open deltas the swaps created, with no separate cap.
          // Already bounded by the swap actions above.
          break;
        case V4Action.TAKE:
        case V4Action.TAKE_ALL:
        case V4Action.TAKE_PORTION:
        case V4Action.TAKE_PAIR:
        case V4Action.CLOSE_CURRENCY:
        case V4Action.CLEAR_OR_TAKE:
          // Inbound, or a settlement of residue in our favour.
          break;
        default:
          return undefined;
      }
    } catch {
      return undefined;
    }
  }

  return outflow;
}
