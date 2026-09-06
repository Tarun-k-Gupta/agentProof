import { DecoderRegistry } from './registry.ts';
import { erc20Decoder } from './erc20.ts';
import { nativeDecoder } from './native.ts';
import { uniswapV4Decoder } from './uniswapV4.ts';
import { x402Decoder } from './x402.ts';

export { DecoderRegistry } from './registry.ts';
export type { DecoderContext, SelectorDecoder } from './registry.ts';
export { erc20Decoder } from './erc20.ts';
export { nativeDecoder } from './native.ts';
export { uniswapV4Decoder } from './uniswapV4.ts';
export { x402Decoder, x402PaymentAction } from './x402.ts';

/**
 * The registry the SDK uses unless the caller supplies their own.
 *
 * Order of registration does not affect decoding: selectors are unique and the
 * registry throws on a collision. Wildcards (native) are consulted last.
 */
export function createDefaultRegistry(): DecoderRegistry {
  return new DecoderRegistry()
    .register(erc20Decoder)
    .register(uniswapV4Decoder)
    .register(x402Decoder)
    .register(nativeDecoder);
}
