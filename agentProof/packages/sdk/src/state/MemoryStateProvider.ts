import type { Address, Hex, NormalizedIntent } from '../core/types.ts';
import type { StateProvider } from '../ports/index.ts';

/**
 * Deterministic in-memory state. Used by unit tests, the differential fuzz
 * suite and CI, where reaching for an indexer would make the tests both slow
 * and untrustworthy.
 */
export class MemoryStateProvider implements StateProvider {
  private readonly spend = new Map<string, bigint>();
  private readonly balances = new Map<string, bigint>();
  readonly executions: Array<{ account: Address; intent: NormalizedIntent; txHash: Hex }> = [];

  constructor(initialBalances: Record<string, bigint> = {}) {
    for (const [key, value] of Object.entries(initialBalances)) this.balances.set(key.toLowerCase(), value);
  }

  async getDailySpend(account: Address, dayUtc: number): Promise<bigint> {
    return this.spend.get(`${account.toLowerCase()}:${dayUtc}`) ?? 0n;
  }

  async getBalance(account: Address, asset: Address): Promise<bigint> {
    return this.balances.get(`${account.toLowerCase()}:${asset.toLowerCase()}`) ?? 0n;
  }

  async recordExecution(account: Address, intent: NormalizedIntent, txHash: Hex): Promise<void> {
    this.executions.push({ account, intent, txHash });
  }

  // -------------------------------------------------------------- test hooks

  setBalance(account: Address, asset: Address, amount: bigint): void {
    this.balances.set(`${account.toLowerCase()}:${asset.toLowerCase()}`, amount);
  }

  addSpend(account: Address, dayUtc: number, amount: bigint): void {
    const key = `${account.toLowerCase()}:${dayUtc}`;
    this.spend.set(key, (this.spend.get(key) ?? 0n) + amount);
  }

  reset(): void {
    this.spend.clear();
    this.executions.length = 0;
  }
}
