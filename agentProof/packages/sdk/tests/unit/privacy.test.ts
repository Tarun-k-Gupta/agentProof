import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CommitmentScheme, bucketAmount, redact, truncateAddress } from '../../src/privacy/index.ts';
import { usdc } from '../../src/utils/units.ts';
import type { Address, NormalizedIntent } from '../../src/core/types.ts';

const ME = '0x00000000000000000000000000000000000000a1' as Address;
const KEY = '0x' + 'ab'.repeat(32);

const intent: NormalizedIntent = {
  kind: 'TRANSFER',
  target: ME,
  selector: '0xa9059cbb',
  nativeValue: 0n,
  outflow: [{ asset: ME, amount: usdc(40), provenance: 'DECODED' }],
  counterparty: ME,
  notionalUSDC: usdc(40),
  summary: 'test',
  raw: { to: ME, data: '0x', value: 0n, chainId: 1 },
};

describe('redaction', () => {
  test('truncates addresses so logs correlate without publishing', () => {
    assert.equal(truncateAddress(ME), '0x0000…00a1');
  });

  test('removes values under secret-looking keys entirely', () => {
    const output = redact({ privateKey: KEY, apiKey: 'sk-live-123', sessionKey: KEY }) as Record<string, unknown>;
    assert.equal(output.privateKey, '[redacted]');
    assert.equal(output.apiKey, '[redacted]');
    assert.equal(output.sessionKey, '[redacted]');
  });

  // A truncated private key is still a meaningful reduction in search space, so
  // loose 32-byte hex is masked wherever it appears, not shortened.
  test('masks loose 32-byte hex even under an innocent key name', () => {
    const output = redact({ note: `the value is ${KEY} ok` }) as Record<string, string>;
    assert.ok(!output.note.includes('abab'), 'raw key material must not survive redaction');
    assert.match(output.note, /redacted-32-bytes/);
  });

  test('recurses into nested structures and arrays', () => {
    const output = redact({ a: [{ secret: KEY }, { addr: ME }] }) as { a: Array<Record<string, string>> };
    assert.equal(output.a[0].secret, '[redacted]');
    assert.equal(output.a[1].addr, '0x0000…00a1');
  });

  test('terminates on deeply nested input', () => {
    let nested: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 50; i++) nested = { nested };
    assert.doesNotThrow(() => redact(nested));
  });
});

describe('commitments', () => {
  test('are stable for identical inputs and differ across intents', () => {
    const scheme = new CommitmentScheme();
    const a = scheme.commit(ME, intent, 'ALLOW');
    const b = scheme.commit(ME, intent, 'ALLOW');
    const c = scheme.commit(ME, { ...intent, notionalUSDC: usdc(41) }, 'ALLOW');

    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  // Without a salt the input space is small enough to enumerate, so two
  // processes must not produce the same commitment for the same action.
  test('are not brute-forceable across processes', () => {
    const a = new CommitmentScheme().commit(ME, intent, 'ALLOW');
    const b = new CommitmentScheme().commit(ME, intent, 'ALLOW');
    assert.notEqual(a, b);
  });

  test('a revealed preimage reproduces the commitment', () => {
    const scheme = new CommitmentScheme();
    const { commitment, preimage } = scheme.reveal(ME, intent, 'ALLOW');
    assert.equal(scheme.commit(ME, intent, 'ALLOW'), commitment);
    assert.ok(preimage.includes('TRANSFER'));
  });
});

describe('amount bucketing', () => {
  test('coarsens amounts to orders of magnitude', () => {
    assert.equal(bucketAmount(usdc(0.5)), '<1');
    assert.equal(bucketAmount(usdc(40)), '10-100');
    assert.equal(bucketAmount(usdc(250)), '100-1000');
    assert.equal(bucketAmount(usdc(500_000)), '>=100000');
  });

  // The property that matters: two different amounts in the same band must be
  // indistinguishable on the public ledger.
  test('does not distinguish amounts within a band', () => {
    assert.equal(bucketAmount(usdc(11)), bucketAmount(usdc(99)));
  });
});
