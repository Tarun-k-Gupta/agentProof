import type { Address, Hex } from '../core/types.ts';
import type { ChainReader, Logger } from '../ports/index.ts';
import { keccak256 } from '../crypto/keccak.ts';
import { normalizeAddress } from '../utils/hex.ts';

/**
 * A real chain reader, over plain JSON-RPC.
 *
 * Deliberately not viem. Reads are the only chain access the policy engine
 * needs — balances, the hook's accumulator, ENS records — and all of them are
 * `eth_call`. Doing that with `fetch` keeps the SDK's runtime dependency count
 * at zero for the entire decision path, which means the thing making safety
 * decisions has no supply chain.
 *
 * Signing is different and does use viem: see ViemExecutor. The asymmetry is
 * intentional — reading is simple enough to own, signing is not.
 */
export class JsonRpcChainReader implements ChainReader {
  readonly chainId: number;
  private readonly url: string;
  private readonly logger?: Logger;
  private readonly timeoutMs: number;
  private nextId = 1;

  constructor(options: { url: string; chainId: number; logger?: Logger; timeoutMs?: number }) {
    this.url = options.url;
    this.chainId = options.chainId;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async call(to: Address, data: Hex): Promise<Hex> {
    return this.rpc<Hex>('eth_call', [{ to, data }, 'latest']);
  }

  async getErc20Balance(asset: Address, account: Address): Promise<bigint> {
    const data = `${BALANCE_OF}${account.slice(2).toLowerCase().padStart(64, '0')}` as Hex;
    const raw = await this.call(asset, data);
    return raw === '0x' ? 0n : BigInt(raw);
  }

  async getBlockTimestamp(): Promise<number> {
    const block = await this.rpc<{ timestamp: Hex }>('eth_getBlockByNumber', ['latest', false]);
    return Number(BigInt(block.timestamp));
  }

  /** Exposed so deploy scripts and the API can sanity-check they are on Sepolia. */
  async assertChainId(): Promise<void> {
    const actual = Number(BigInt(await this.rpc<Hex>('eth_chainId', [])));
    if (actual !== this.chainId) {
      throw new Error(
        `RPC endpoint is chain ${actual} but this SDK is configured for ${this.chainId}. ` +
          'Refusing to evaluate policy against the wrong chain.',
      );
    }
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`RPC ${method} returned HTTP ${response.status}`);

      const body = (await response.json()) as { result?: T; error?: { message: string; data?: unknown } };
      if (body.error) {
        // Revert data is the interesting part of a failed eth_call — it carries
        // the custom error the hook threw.
        throw new RpcError(method, body.error.message, body.error.data);
      }
      return body.result as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class RpcError extends Error {
  readonly data?: unknown;
  constructor(method: string, message: string, data?: unknown) {
    super(`${method}: ${message}`);
    this.name = 'RpcError';
    this.data = data;
  }
}

const BALANCE_OF = keccak256('balanceOf(address)').slice(0, 10);
