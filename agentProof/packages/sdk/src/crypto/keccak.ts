/**
 * keccak256 — Ethereum's original-padding Keccak, not NIST SHA3-256.
 *
 * Implemented here rather than pulled from a dependency for one reason: the
 * policy hash is a security boundary. It is compared against a value published
 * in ENS and a value stored on-chain, and a mismatch stops the agent from
 * starting. A hash function on that path should be readable, pinned, and
 * supply-chain-free.
 *
 * Note that node:crypto's 'sha3-256' is NOT interchangeable — it uses NIST
 * padding (0x06) where Ethereum uses 0x01, and produces a different digest.
 *
 * Verified against the standard vectors in tests/unit/keccak.test.ts.
 */

const MASK = (1n << 64n) - 1n;

const ROUND_CONSTANTS: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// rho offsets, lane index = x + 5y
const ROTATION: bigint[] = [
  0n, 1n, 62n, 28n, 27n,
  36n, 44n, 6n, 55n, 20n,
  3n, 10n, 43n, 25n, 39n,
  41n, 45n, 15n, 21n, 8n,
  18n, 2n, 61n, 56n, 14n,
];

const RATE_BYTES = 136; // 1600 - 2*256 bits

function rotl(x: bigint, n: bigint): bigint {
  return ((x << n) | (x >> (64n - n))) & MASK;
}

function permute(state: bigint[]): void {
  const b = new Array<bigint>(25);
  const c = new Array<bigint>(5);
  const d = new Array<bigint>(5);

  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) {
      c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1n);
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) state[y * 5 + x] ^= d[x];
    }

    // rho + pi
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const src = y * 5 + x;
        const dst = ((2 * x + 3 * y) % 5) * 5 + y;
        b[dst] = rotl(state[src], ROTATION[src]);
      }
    }

    // chi
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        state[y * 5 + x] = b[y * 5 + x] ^ (~b[y * 5 + ((x + 1) % 5)] & MASK & b[y * 5 + ((x + 2) % 5)]);
      }
    }

    // iota
    state[0] ^= ROUND_CONSTANTS[round];
  }
}

/** @returns the 32-byte keccak256 digest of `input`. */
export function keccak256Bytes(input: Uint8Array): Uint8Array {
  const state = new Array<bigint>(25).fill(0n);

  // Pad: 0x01 … 0x80 (Keccak original padding).
  const padded = new Uint8Array(Math.ceil((input.length + 1) / RATE_BYTES) * RATE_BYTES);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  // Absorb.
  for (let offset = 0; offset < padded.length; offset += RATE_BYTES) {
    for (let lane = 0; lane < RATE_BYTES / 8; lane++) {
      let value = 0n;
      for (let byte = 7; byte >= 0; byte--) {
        value = (value << 8n) | BigInt(padded[offset + lane * 8 + byte]);
      }
      state[lane] ^= value;
    }
    permute(state);
  }

  // Squeeze 32 bytes.
  const out = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane++) {
    let value = state[lane];
    for (let byte = 0; byte < 8; byte++) {
      out[lane * 8 + byte] = Number(value & 0xffn);
      value >>= 8n;
    }
  }
  return out;
}

/** @returns the 0x-prefixed keccak256 digest of a UTF-8 string. */
export function keccak256(input: string | Uint8Array): `0x${string}` {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = keccak256Bytes(bytes);
  let hex = '0x';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex as `0x${string}`;
}
