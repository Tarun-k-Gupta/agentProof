import { createHash } from 'node:crypto';

/**
 * Payment replay guard.
 *
 * An x402 payment payload authorises exactly one call. Nothing in the HTTP
 * exchange stops a caller from sending the same `X-PAYMENT` header a second
 * time, and a facilitator that has already settled it will usually answer the
 * second `/verify` the same way it answered the first. Without this the price
 * of the endpoint is "one payment, unlimited calls".
 *
 * The guard is in-memory and therefore per-process: it is a rate-limit on
 * reuse, not a distributed ledger. That is the honest scope. The settlement
 * record on Hedera remains the authority on what was actually paid.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(private readonly options: { ttlMs?: number; max?: number } = {}) {}

  private get ttlMs(): number {
    return this.options.ttlMs ?? 15 * 60 * 1000;
  }

  private get max(): number {
    return this.options.max ?? 10_000;
  }

  /**
   * Claims a payment payload. Returns false if this payload has already been
   * used, in which case the caller must not do the work.
   */
  claim(payload: string, now = Date.now()): boolean {
    this.evict(now);
    const key = digest(payload);
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    return true;
  }

  /**
   * Releases a claim. Used when the work itself failed, so a caller is not
   * charged for an outage and can retry with the same payment.
   */
  release(payload: string): void {
    this.seen.delete(digest(payload));
  }

  private evict(now: number): void {
    for (const [key, at] of this.seen) {
      if (now - at > this.ttlMs) this.seen.delete(key);
      else break; // Map preserves insertion order, so the rest are newer.
    }
    while (this.seen.size > this.max) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
  }
}

function digest(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}
