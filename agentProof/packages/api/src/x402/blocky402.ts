import type { HttpClient, Logger } from '@agentproof/sdk';

/**
 * Blocky402 facilitator client (Hedera testnet).
 *
 * Hedera's x402 scheme differs from the EVM one in a way that matters here:
 * the client partially signs a transaction, the facilitator adds its own
 * signature, pays the gas and submits. We never hold the client's key and we
 * never submit on their behalf.
 *
 * Verify `/supported` returns hedera-testnet before trusting any of this. A
 * facilitator that does not list the network will accept a challenge and then
 * fail to settle, which looks exactly like a working integration until the
 * moment it is demonstrated.
 */

export interface PaymentRequirements {
  scheme: 'exact';
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  resource: string;
  description: string;
  maxTimeoutSeconds: number;
  facilitator: string;
  nonce: string;
}

export interface SettlementResult {
  settled: boolean;
  transactionId?: string;
  network?: string;
  payer?: string;
  reason?: string;
}

/**
 * The seam the gate depends on. `Blocky402Facilitator` is the production
 * implementation; tests supply their own rather than standing up a facilitator.
 */
export interface Facilitator {
  verify(payload: string, requirements: PaymentRequirements): Promise<{ valid: boolean; reason?: string }>;
  settle(payload: string, requirements: PaymentRequirements): Promise<SettlementResult>;
}

export class Blocky402Facilitator implements Facilitator {
  constructor(
    private readonly options: { baseUrl: string; http: HttpClient; logger?: Logger; network?: string },
  ) {}

  private get network(): string {
    return this.options.network ?? 'hedera-testnet';
  }

  /**
   * Startup check. Called once, loudly, before the service accepts traffic.
   * @throws if the facilitator does not support our network and scheme.
   */
  async assertSupported(): Promise<void> {
    const supported = await this.options.http.getJson<{ kinds?: Array<{ scheme: string; network: string }> }>(
      `${this.options.baseUrl}/supported`,
    );
    const ok = supported.kinds?.some((k) => k.network === this.network && k.scheme === 'exact');
    if (!ok) {
      throw new Error(
        `Facilitator ${this.options.baseUrl} does not advertise scheme=exact on ${this.network}. ` +
          `Advertised: ${JSON.stringify(supported.kinds ?? [])}. Refusing to start rather than serving ` +
          '402 challenges that cannot be settled.',
      );
    }
    this.options.logger?.log('info', 'facilitator supports our network', { network: this.network });
  }

  /** Cryptographic verification of a payment payload, before we do any work. */
  async verify(payload: string, requirements: PaymentRequirements): Promise<{ valid: boolean; reason?: string }> {
    try {
      return await this.options.http.postJson<{ valid: boolean; reason?: string }>(
        `${this.options.baseUrl}/verify`,
        { paymentPayload: decodePayload(payload), paymentRequirements: requirements },
      );
    } catch (error) {
      return { valid: false, reason: error instanceof Error ? error.message : 'verify call failed' };
    }
  }

  /** Settlement. Called only after the work has succeeded. */
  async settle(payload: string, requirements: PaymentRequirements): Promise<SettlementResult> {
    try {
      const response = await this.options.http.postJson<SettlementResult>(`${this.options.baseUrl}/settle`, {
        paymentPayload: decodePayload(payload),
        paymentRequirements: requirements,
      });
      this.options.logger?.log('info', 'payment settled', {
        transactionId: response.transactionId,
        network: response.network,
      });
      return response;
    } catch (error) {
      return { settled: false, reason: error instanceof Error ? error.message : 'settle call failed' };
    }
  }
}

function decodePayload(header: string): unknown {
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    throw new Error('X-PAYMENT header is not valid base64 JSON');
  }
}
