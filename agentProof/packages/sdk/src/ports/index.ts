/**
 * Ports.
 *
 * Every external system the SDK touches — a chain, an indexer, a hardware
 * wallet, a clock — enters through one of these interfaces. Three consequences
 * that matter:
 *
 *   1. The policy engine has zero runtime dependencies and runs anywhere.
 *   2. Every adapter is swappable, so the demo, CI and production differ only
 *      in wiring.
 *   3. The trust boundary is legible. If you want to know what the SDK can
 *      reach, read this file.
 */

import type { Address, Hex, NormalizedIntent } from '../core/types.ts';

export interface ChainReader {
  readonly chainId: number;
  getErc20Balance(asset: Address, account: Address): Promise<bigint>;
  /** eth_call against a deployed contract; returns raw return data */
  call(to: Address, data: Hex): Promise<Hex>;
  getBlockTimestamp(): Promise<number>;
}

export interface UserOperationRequest {
  account: Address;
  to: Address;
  data: Hex;
  value: bigint;
}

export interface Executor {
  /** Signs with the agent session key and submits. Throws on revert. */
  send(request: UserOperationRequest): Promise<Hex>;
  /** Signs with the owner validator — used only after human approval. */
  sendAsOwner?(request: UserOperationRequest, signature: Hex): Promise<Hex>;
}

export interface StateProvider {
  getDailySpend(account: Address, dayUtc: number): Promise<bigint>;
  getBalance(account: Address, asset: Address): Promise<bigint>;
  recordExecution(account: Address, intent: NormalizedIntent, txHash: Hex): Promise<void>;
}

export interface IdentityProvider {
  /**
   * Resolves the agent's name and returns the policy hash published on-chain.
   * The SDK refuses to start if this disagrees with the local policy file.
   */
  resolvePolicyHash(name: string): Promise<Hex>;
  resolveAccount(name: string): Promise<Address>;
  resolveHook(name: string): Promise<Address>;
  resolveStatus(name: string): Promise<'active' | 'suspended' | string>;
}

export interface Approver {
  request(request: import('../core/types.ts').ApprovalRequest): Promise<import('../core/types.ts').ApprovalOutcome>;
}

export interface Clock {
  now(): number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
}

export interface HttpClient {
  postJson<T>(url: string, body: unknown, headers?: Record<string, string>): Promise<T>;
  getJson<T>(url: string, headers?: Record<string, string>): Promise<T>;
}

export const systemClock: Clock = { now: () => Date.now() };
