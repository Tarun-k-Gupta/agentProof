import type { Address, Hex } from '../core/types.ts';

/**
 * Calldata encoders.
 *
 * These exist so that agents, test fixtures and the demo all build calldata the
 * same way, and so that every decoder can be tested by round-tripping against
 * the encoder rather than against a hex string someone pasted in once and
 * nobody has re-read since.
 *
 * A round-trip test is not a substitute for real calldata, and the fixture
 * suite also carries captured Sepolia transactions. But it catches the class of
 * bug where a decoder and its author agree with each other and with nothing
 * else.
 */

const word = (value: bigint | number | string): string => BigInt(value).toString(16).padStart(64, '0');

function padBytes(hexBody: string): string {
  const words = Math.ceil(hexBody.length / 64);
  return hexBody.padEnd(words * 64, '0');
}

/** ABI-encodes a `bytes` argument: length word followed by padded content. */
function encodeBytes(hexBody: string): string {
  return word(hexBody.length / 2) + padBytes(hexBody);
}

export function encodeErc20Transfer(to: Address, amount: bigint): Hex {
  return `0xa9059cbb${word(BigInt(to))}${word(amount)}`;
}

export function encodeErc20Approve(spender: Address, amount: bigint): Hex {
  return `0x095ea7b3${word(BigInt(spender))}${word(amount)}`;
}

export function encodeErc20TransferFrom(from: Address, to: Address, amount: bigint): Hex {
  return `0x23b872dd${word(BigInt(from))}${word(BigInt(to))}${word(amount)}`;
}

export const UNLIMITED_APPROVAL = (1n << 256n) - 1n;

/**
 * Universal Router `execute(bytes commands, bytes[] inputs)`.
 *
 * @param commands one byte per command, in execution order
 * @param inputs   the ABI-encoded argument blob for each command
 */
export function encodeUniversalRouterExecute(commands: readonly number[], inputs: readonly string[]): Hex {
  if (commands.length !== inputs.length) {
    throw new Error('encodeUniversalRouterExecute: commands and inputs must be the same length');
  }

  const commandsBody = commands.map((c) => c.toString(16).padStart(2, '0')).join('');
  const commandsSection = encodeBytes(commandsBody);

  // Element offsets are relative to the start of the offset region, i.e. just
  // after the array's length word.
  const elements = inputs.map((input) => encodeBytes(input));
  let cursor = elements.length * 32;
  const offsets: string[] = [];
  for (const element of elements) {
    offsets.push(word(cursor));
    cursor += element.length / 2;
  }

  const inputsSection = word(elements.length) + offsets.join('') + elements.join('');

  const offsetCommands = 64;
  const offsetInputs = offsetCommands + commandsSection.length / 2;

  return `0x24856bc3${word(offsetCommands)}${word(offsetInputs)}${commandsSection}${inputsSection}` as Hex;
}

/** V3_SWAP_EXACT_IN input: (recipient, amountIn, amountOutMin, path, payerIsUser) */
export function encodeExactInInput(params: {
  recipient: Address;
  amountIn: bigint;
  amountOutMin?: bigint;
  tokenIn: Address;
  tokenOut: Address;
  fee?: number;
}): string {
  const path =
    params.tokenIn.slice(2) +
    (params.fee ?? 3000).toString(16).padStart(6, '0') +
    params.tokenOut.slice(2);

  const pathOffset = 5 * 32; // five head words precede the dynamic path
  return (
    word(BigInt(params.recipient)) +
    word(params.amountIn) +
    word(params.amountOutMin ?? 0n) +
    word(pathOffset) +
    word(1) + // payerIsUser
    encodeBytes(path)
  );
}

/** V3_SWAP_EXACT_OUT input: (recipient, amountOut, amountInMaximum, path, payerIsUser) */
export function encodeExactOutInput(params: {
  recipient: Address;
  amountOut: bigint;
  amountInMaximum: bigint;
  tokenIn: Address;
  tokenOut: Address;
  fee?: number;
}): string {
  const path =
    params.tokenOut.slice(2) +
    (params.fee ?? 3000).toString(16).padStart(6, '0') +
    params.tokenIn.slice(2);

  return (
    word(BigInt(params.recipient)) +
    word(params.amountOut) +
    word(params.amountInMaximum) +
    word(5 * 32) +
    word(1) +
    encodeBytes(path)
  );
}

/** Convenience: a single exact-input swap, the shape the trader proposes. */
export function encodeSwapExactIn(params: {
  recipient: Address;
  amountIn: bigint;
  tokenIn: Address;
  tokenOut: Address;
}): Hex {
  return encodeUniversalRouterExecute([0x00], [encodeExactInInput(params)]);
}

/** Convenience: an exact-output swap, where amountInMaximum is what binds. */
export function encodeSwapExactOut(params: {
  recipient: Address;
  amountOut: bigint;
  amountInMaximum: bigint;
  tokenIn: Address;
  tokenOut: Address;
}): Hex {
  return encodeUniversalRouterExecute([0x01], [encodeExactOutInput(params)]);
}

/** ERC-7579 `execute(bytes32 mode, bytes executionCalldata)`, single call type. */
export function encodeErc7579Execute(target: Address, value: bigint, callData: Hex): Hex {
  const packed = target.slice(2) + word(value) + callData.slice(2);
  return `0xe9ae5c53${word(0)}${word(64)}${encodeBytes(packed)}` as Hex;
}
