import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from '../../src/crypto/keccak.ts';
import { canonicalJSON, policyHash } from '../../src/core/policy.ts';
import type { PolicyDocument } from '../../src/core/types.ts';

describe('keccak256', () => {
  // Ethereum uses original Keccak padding, not NIST SHA3. These vectors are the
  // difference between the two, and getting it wrong would silently break the
  // policy-hash binding rather than fail loudly.
  test('matches the standard vectors', () => {
    assert.equal(keccak256(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
    assert.equal(keccak256('abc'), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
    assert.equal(keccak256('hello'), '0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8');
  });

  test('handles input spanning multiple sponge blocks', () => {
    // 200 bytes exceeds the 136-byte rate, exercising the absorb loop.
    const digest = keccak256('a'.repeat(200));
    assert.match(digest, /^0x[0-9a-f]{64}$/);
    assert.notEqual(digest, keccak256('a'.repeat(199)));
  });

  test('derives known function selectors', () => {
    assert.equal(keccak256('transfer(address,uint256)').slice(0, 10), '0xa9059cbb');
    assert.equal(keccak256('approve(address,uint256)').slice(0, 10), '0x095ea7b3');
    assert.equal(keccak256('execute(bytes32,bytes)').slice(0, 10), '0xe9ae5c53');
  });
});

describe('canonical JSON', () => {
  test('is independent of key insertion order', () => {
    const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
    const b = { c: { y: 2, z: 1 }, a: 2, b: 1 };
    assert.equal(canonicalJSON(a), canonicalJSON(b));
  });

  test('preserves array order, which is semantic', () => {
    assert.notEqual(canonicalJSON({ x: [1, 2] }), canonicalJSON({ x: [2, 1] }));
  });
});

describe('policyHash', () => {
  const base: PolicyDocument = {
    version: 'agentproof/v1',
    agent: 'trader.agentproof.eth',
    chainId: 11155111,
    asset: { address: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238', decimals: 6 },
    policies: {
      maxTransaction: '100000000',
      dailySpend: '500000000',
      approvalThreshold: '100000000',
      minBalance: '10000000',
      allowedContracts: ['0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad'],
      allowedRecipients: [],
    },
    enforcement: {
      hook: '0x0000000000000000000000000000000000000000',
      account: '0x00000000000000000000000000000000000000a1',
    },
  };

  test('is stable across reserialisation', () => {
    assert.equal(policyHash(base), policyHash(JSON.parse(JSON.stringify(base)) as PolicyDocument));
  });

  test('changes when any limit changes', () => {
    const widened = { ...base, policies: { ...base.policies, maxTransaction: '1000000000' } };
    assert.notEqual(policyHash(base), policyHash(widened));
  });

  test('changes when an allowlist entry is added', () => {
    const extra = {
      ...base,
      policies: {
        ...base.policies,
        allowedRecipients: ['0x000000000000000000000000000000000000dead' as const],
      },
    };
    assert.notEqual(policyHash(base), policyHash(extra));
  });
});
