import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultRegistry } from '../../src/decode/index.ts';
import {
  encodeErc20Approve,
  encodeErc20Transfer,
  encodeErc20TransferFrom,
  encodeSwapExactIn,
  encodeSwapExactOut,
  encodeUniversalRouterExecute,
  encodeExactInInput,
  UNLIMITED_APPROVAL,
} from '../../src/testing/calldata.ts';
import { usdc, UNBOUNDED } from '../../src/utils/units.ts';
import type { Action, Address } from '../../src/core/types.ts';

const ROUTER = '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad' as Address;
const USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238' as Address;
const WETH = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14' as Address;
const ME = '0x00000000000000000000000000000000000000a1' as Address;
const OTHER = '0x00000000000000000000000000000000000000b2' as Address;

const registry = createDefaultRegistry();
const ctx = { account: ME, trackedAsset: USDC, decimals: 6 };
const action = (to: Address, data: string, value = 0n): Action =>
  ({ to, data: data as `0x${string}`, value, chainId: 11155111 });

describe('ERC-20 decoding', () => {
  test('decodes a transfer to amount and recipient', () => {
    const intent = registry.decode(action(USDC, encodeErc20Transfer(OTHER, usdc(40))), ctx);
    assert.equal(intent.kind, 'TRANSFER');
    assert.equal(intent.notionalUSDC, usdc(40));
    assert.equal(intent.counterparty, OTHER);
    assert.equal(intent.outflow[0].provenance, 'DECODED');
  });

  // The rule that catches threat T4. An approval is a standing licence to move
  // funds, so its worst-case cost is the whole allowance, not zero.
  test('treats a bounded approval as an outflow of the full allowance', () => {
    const intent = registry.decode(action(USDC, encodeErc20Approve(ROUTER, usdc(250))), ctx);
    assert.equal(intent.kind, 'APPROVE');
    assert.equal(intent.notionalUSDC, usdc(250));
  });

  test('treats an unlimited approval as unbounded', () => {
    const intent = registry.decode(action(USDC, encodeErc20Approve(ROUTER, UNLIMITED_APPROVAL)), ctx);
    assert.equal(intent.notionalUSDC, UNBOUNDED);
    assert.match(intent.summary, /UNLIMITED/);
  });

  test('counts transferFrom only when funds leave our own account', () => {
    const ours = registry.decode(action(USDC, encodeErc20TransferFrom(ME, OTHER, usdc(30))), ctx);
    assert.equal(ours.notionalUSDC, usdc(30));

    const theirs = registry.decode(action(USDC, encodeErc20TransferFrom(OTHER, ME, usdc(30))), ctx);
    assert.equal(theirs.notionalUSDC, 0n, 'an inbound pull is not our outflow');
  });

  test('ignores notional for an untracked token but still exposes the counterparty', () => {
    const intent = registry.decode(action(WETH, encodeErc20Transfer(OTHER, usdc(40))), ctx);
    assert.equal(intent.notionalUSDC, 0n);
    assert.equal(intent.counterparty, OTHER, 'the allowlist still needs to see where this is going');
  });
});

describe('Uniswap Universal Router decoding', () => {
  test('decodes an exact-input swap to its input amount', () => {
    const intent = registry.decode(
      action(ROUTER, encodeSwapExactIn({ recipient: ME, amountIn: usdc(80), tokenIn: USDC, tokenOut: WETH })),
      ctx,
    );
    assert.equal(intent.kind, 'SWAP');
    assert.equal(intent.notionalUSDC, usdc(80));
  });

  // The single most important line in the Uniswap decoder. A swap quoted at 90
  // with amountInMaximum of 250 can cost 250. Reading the quote would let it
  // through a 100 limit.
  test('uses amountInMaximum for an exact-output swap, never the quote', () => {
    const intent = registry.decode(
      action(
        ROUTER,
        encodeSwapExactOut({
          recipient: ME,
          amountOut: usdc(90),
          amountInMaximum: usdc(250),
          tokenIn: USDC,
          tokenOut: WETH,
        }),
      ),
      ctx,
    );
    assert.equal(intent.notionalUSDC, usdc(250));
  });

  test('sums a multi-command stream', () => {
    const input = encodeExactInInput({ recipient: ME, amountIn: usdc(30), tokenIn: USDC, tokenOut: WETH });
    const intent = registry.decode(action(ROUTER, encodeUniversalRouterExecute([0x00, 0x00], [input, input])), ctx);
    assert.equal(intent.notionalUSDC, usdc(60));
  });

  // A swap bundled with one command we cannot read is an unreadable swap. It
  // must not be bounded by the part we happen to understand.
  test('treats a stream containing an unknown command as unbounded', () => {
    const input = encodeExactInInput({ recipient: ME, amountIn: usdc(30), tokenIn: USDC, tokenOut: WETH });
    const intent = registry.decode(action(ROUTER, encodeUniversalRouterExecute([0x00, 0x1e], [input, input])), ctx);
    assert.equal(intent.kind, 'UNKNOWN');
    assert.equal(intent.notionalUSDC, UNBOUNDED);
  });
});

describe('fallbacks', () => {
  test('classifies an unknown selector as UNKNOWN and unbounded', () => {
    const intent = registry.decode(action(ROUTER, '0xdeadbeef'), ctx);
    assert.equal(intent.kind, 'UNKNOWN');
    assert.equal(intent.notionalUSDC, UNBOUNDED);
  });

  test('decodes a bare native send', () => {
    const intent = registry.decode(action(OTHER, '0x', 10n ** 18n), ctx);
    assert.equal(intent.kind, 'NATIVE_TRANSFER');
    assert.equal(intent.nativeValue, 10n ** 18n);
  });

  test('refuses to register two decoders for one selector', () => {
    const clash = { name: 'clash', selectors: ['0xa9059cbb'], decode: () => undefined };
    assert.throws(() => createDefaultRegistry().register(clash), /claimed by both/);
  });
});
