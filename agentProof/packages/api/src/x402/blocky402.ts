import type { HttpClient, Logger } from '@agentproof/sdk';

/**
 * Blocky402 facilitator client (Hedera testnet).
 *
 * Hedera's x402 scheme differs from the EVM one in a way that matters here:
 * the client partially signs a transaction, the facilitator adds its own
 * signature, pays the gas and submits. We never hold the client's key and we
 * never submit on their behalf.
 *
 * Verify `/supported` returns hedera:testnet before trusting any of this. A
 * facilitator that does not list the network will accept a challenge and then
 * fail to settle, which looks exactly like a working integration until the
 * moment it is demonstrated.
 */

export interface PaymentRequirements {
  scheme: 'exact';
  network: string;
  asset: string;
  /** atomic units of the asset (tinybars for HBAR): the facilitator settles exactly this */
  amount: string;
  payTo: string;
  resource: string;
  description: string;
  maxTimeoutSeconds: number;
  facilitator: string;
  nonce: string;
  /** e.g. { feePayer } for Hedera, from the facilitator's /supported */
  extra?: { feePayer?: string };
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
  private feePayerValue?: string;

  constructor(
    private readonly options: { baseUrl: string; http: HttpClient; logger?: Logger; network?: string },
  ) {}

  /** Fee-payer advertised for our network, if assertSupported has run. */
  get feePayer(): string | undefined {
    return this.feePayerValue;
  }

  private get network(): string {
    // CAIP-style x402 network id, as the facilitator advertises it.
    return this.options.network ?? 'hedera:testnet';
  }

  /**
   * Startup check. Called once, loudly, before the service accepts traffic.
   * @throws if the facilitator does not support our network and scheme.
   */
  async assertSupported(): Promise<void> {
    const supported = await this.options.http.getJson<{
      kinds?: Array<{ scheme: string; network: string; extra?: { feePayer?: string } }>;
    }>(`${this.options.baseUrl}/supported`);
    const kind = supported.kinds?.find((k) => k.network === this.network && k.scheme === 'exact');
    if (!kind) {
      throw new Error(
        `Facilitator ${this.options.baseUrl} does not advertise scheme=exact on ${this.network}. ` +
          `Advertised: ${JSON.stringify(supported.kinds ?? [])}. Refusing to start rather than serving ` +
          '402 challenges that cannot be settled.',
      );
    }
    this.feePayerValue = kind.extra?.feePayer;
    this.options.logger?.log('info', 'facilitator supports our network', {
      network: this.network,
      feePayer: this.feePayerValue,
    });
  }

  /** Cryptographic verification of a payment payload, before we do any work. */
  async verify(payload: string, requirements: PaymentRequirements): Promise<{ valid: boolean; reason?: string }> {
    try {
      const response = await this.options.http.postJson<{
        isValid?: boolean;
        payer?: string;
        invalidReason?: string;
        invalidMessage?: string;
      }>(`${this.options.baseUrl}/verify`, {
        x402Version: 2,
        paymentPayload: decodePayload(payload),
        paymentRequirements: requirements,
      });
      if (response.isValid) return { valid: true };
      return {
        valid: false,
        reason: [response.invalidReason, response.invalidMessage].filter(Boolean).join(': ') || 'verify rejected',
      };
    } catch (error) {
      return { valid: false, reason: error instanceof Error ? error.message : 'verify call failed' };
    }
  }

  /** Settlement. Called only after the work has succeeded. */
  async settle(payload: string, requirements: PaymentRequirements): Promise<SettlementResult> {
    try {
      const response = await this.options.http.postJson<{
        success?: boolean;
        transaction?: string;
        network?: string;
        payer?: string;
        errorReason?: string;
        errorMessage?: string;
      }>(`${this.options.baseUrl}/settle`, {
        x402Version: 2,
        paymentPayload: decodePayload(payload),
        paymentRequirements: requirements,
      });
      const settled = response.success === true;
      this.options.logger?.log('info', 'payment settlement attempted', {
        settled,
        transactionId: response.transaction,
        network: response.network,
      });
      return {
        settled,
        transactionId: response.transaction,
        network: response.network,
        payer: response.payer,
        reason: settled
          ? undefined
          : [response.errorReason, response.errorMessage].filter(Boolean).join(': ') || 'settle rejected',
      };
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
