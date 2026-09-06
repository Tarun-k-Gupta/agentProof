import type { Address, Hex } from '../core/types.ts';
import type { ChainReader, IdentityProvider, Logger } from '../ports/index.ts';
import { keccak256 } from '../crypto/keccak.ts';
import { normalizeAddress } from '../utils/hex.ts';

export interface ENSIdentityOptions {
  chain: ChainReader;
  /** ENSv2 Universal Resolver on the target chain (Sepolia in the MVP) */
  universalResolver: Address;
  logger?: Logger;
  /** cache resolved records for this long; 0 disables caching */
  ttlMs?: number;
}

/** Text record keys. Aligned with ENSIP-26 agent record conventions. */
export const ENS_KEY_POLICY = 'agentproof.policy';
export const ENS_KEY_HOOK = 'agentproof.hook';
export const ENS_KEY_STATUS = 'agentproof.status';

/**
 * Agent identity, read from ENSv2.
 *
 * An agent here is not an address with a nickname. It is a namespace:
 *
 *   trader.agentproof.eth
 *     addr                      → the agent's ERC-7579 smart account
 *     text agentproof.policy    → policyHash (keccak256 of canonical JSON)
 *     text agentproof.hook      → the deployed AgentPolicyHook
 *     text agentproof.status    → active | suspended
 *
 * The records are not decoration. `resolvePolicyHash` is what the SDK compares
 * against the local policy file at startup, and a mismatch stops the agent from
 * running at all. Combined with the hash stored in the hook, that gives three
 * independent publishers of the same commitment — a local file, a public name
 * and a contract — and an operator who quietly edits one of them gets a refusal
 * rather than a wider limit.
 *
 * The permissions behind those records matter as much as the values. The owner
 * key holds the EAC role that can repoint `agentproof.policy`; the agent's
 * session key holds only the role that can set `agentproof.status`. An agent
 * can suspend itself and can do nothing else to its own identity.
 */
export class ENSIdentity implements IdentityProvider {
  private readonly cache = new Map<string, { value: string; expiresAt: number }>();
  private readonly ttlMs: number;

  constructor(private readonly options: ENSIdentityOptions) {
    this.ttlMs = options.ttlMs ?? 30_000;
  }

  async resolvePolicyHash(name: string): Promise<Hex> {
    const value = await this.text(name, ENS_KEY_POLICY);
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
      throw new ENSRecordError(name, ENS_KEY_POLICY, `expected a 32-byte hash, got ${JSON.stringify(value)}`);
    }
    return value.toLowerCase() as Hex;
  }

  async resolveHook(name: string): Promise<Address> {
    const value = await this.text(name, ENS_KEY_HOOK);
    try {
      return normalizeAddress(value);
    } catch {
      throw new ENSRecordError(name, ENS_KEY_HOOK, `expected an address, got ${JSON.stringify(value)}`);
    }
  }

  async resolveStatus(name: string): Promise<'active' | 'suspended' | string> {
    return (await this.text(name, ENS_KEY_STATUS)) || 'active';
  }

  async resolveAccount(name: string): Promise<Address> {
    const node = namehash(name);
    // resolve(bytes name, bytes data) on the Universal Resolver, wrapping
    // addr(bytes32) for the target name.
    const inner = (ADDR_SELECTOR + node.slice(2)) as Hex;
    const returned = await this.universalResolve(name, inner);
    const word = returned.slice(-64);
    return normalizeAddress(`0x${word.slice(24)}`);
  }

  // ---------------------------------------------------------------- internals

  private async text(name: string, key: string): Promise<string> {
    const cacheKey = `${name}|${key}`;
    const cached = this.cache.get(cacheKey);
    if (this.ttlMs > 0 && cached && cached.expiresAt > Date.now()) return cached.value;

    const node = namehash(name);
    const inner = encodeText(node, key);
    const returned = await this.universalResolve(name, inner);
    const value = decodeString(returned);

    if (this.ttlMs > 0) this.cache.set(cacheKey, { value, expiresAt: Date.now() + this.ttlMs });
    this.options.logger?.log('debug', 'resolved ENS text record', { name, key, value });
    return value;
  }

  private async universalResolve(name: string, inner: Hex): Promise<string> {
    const dnsName = dnsEncode(name);
    const data = encodeResolveCall(dnsName, inner);
    const raw = await this.options.chain.call(this.options.universalResolver, data);
    if (raw === '0x') throw new ENSRecordError(name, 'resolve', 'Universal Resolver returned no data');
    // resolve() returns (bytes result, address resolver); the first word is the
    // offset to `result`, which we unwrap here.
    const body = raw.slice(2);
    const offset = Number(BigInt(`0x${body.slice(0, 64)}`)) * 2;
    const length = Number(BigInt(`0x${body.slice(offset, offset + 64)}`)) * 2;
    return body.slice(offset + 64, offset + 64 + length);
  }
}

export class ENSRecordError extends Error {
  constructor(name: string, key: string, detail: string) {
    super(`ENS record ${key} on ${name} is unusable: ${detail}`);
    this.name = 'ENSRecordError';
  }
}

// ------------------------------------------------------------------ encoding

const ADDR_SELECTOR = keccak256('addr(bytes32)').slice(0, 10);
const TEXT_SELECTOR = keccak256('text(bytes32,string)').slice(0, 10);
const RESOLVE_SELECTOR = keccak256('resolve(bytes,bytes)').slice(0, 10);

/** EIP-137 namehash. */
export function namehash(name: string): Hex {
  let node = '0x0000000000000000000000000000000000000000000000000000000000000000';
  if (name.length === 0) return node as Hex;

  const labels = name.split('.').reverse();
  for (const label of labels) {
    const labelHash = keccak256(label);
    node = keccak256(concatHex(node as Hex, labelHash));
  }
  return node as Hex;
}

/** DNS wire format, as the Universal Resolver expects. */
export function dnsEncode(name: string): Hex {
  const encoder = new TextEncoder();
  const parts: number[] = [];
  for (const label of name.split('.')) {
    const bytes = encoder.encode(label);
    if (bytes.length > 63) throw new Error(`ENS label too long: ${label}`);
    parts.push(bytes.length, ...bytes);
  }
  parts.push(0);
  return `0x${parts.map((b) => b.toString(16).padStart(2, '0')).join('')}` as Hex;
}

function concatHex(a: Hex, b: Hex): Uint8Array {
  const body = a.slice(2) + b.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function encodeText(node: Hex, key: string): Hex {
  const keyBytes = new TextEncoder().encode(key);
  const padded = Math.ceil(keyBytes.length / 32) * 32;
  const keyHex = [...keyBytes].map((b) => b.toString(16).padStart(2, '0')).join('').padEnd(padded * 2, '0');
  return (TEXT_SELECTOR +
    node.slice(2) +
    (64).toString(16).padStart(64, '0') +
    keyBytes.length.toString(16).padStart(64, '0') +
    keyHex) as Hex;
}

function encodeResolveCall(dnsName: Hex, inner: Hex): Hex {
  const nameBytes = (dnsName.length - 2) / 2;
  const innerBytes = (inner.length - 2) / 2;
  const namePadded = dnsName.slice(2).padEnd(Math.ceil(nameBytes / 32) * 64, '0');
  const innerPadded = inner.slice(2).padEnd(Math.ceil(innerBytes / 32) * 64, '0');
  const nameOffset = 64;
  const innerOffset = nameOffset + 32 + namePadded.length / 2;

  return (RESOLVE_SELECTOR +
    nameOffset.toString(16).padStart(64, '0') +
    innerOffset.toString(16).padStart(64, '0') +
    nameBytes.toString(16).padStart(64, '0') +
    namePadded +
    innerBytes.toString(16).padStart(64, '0') +
    innerPadded) as Hex;
}

function decodeString(returned: string): string {
  if (returned.length === 0) return '';
  const offset = Number(BigInt(`0x${returned.slice(0, 64)}`)) * 2;
  const length = Number(BigInt(`0x${returned.slice(offset, offset + 64)}`));
  const body = returned.slice(offset + 64, offset + 64 + length * 2);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}
