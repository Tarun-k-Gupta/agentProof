import type { Action, Address, HttpClient, Logger } from '@agentproof/sdk';
// Subpath, not the barrel. The barrel reaches ledger.ts, whose dynamic import
// of the transport cannot be statically bundled — pulling it into a Next route
// handler fails the build. x402PaymentAction needs two small utils and nothing
// else, so the deep import costs nothing and keeps this package bundleable.
import { x402PaymentAction } from '@agentproof/sdk/decode/x402';

export { hederaSigner } from './hedera.ts';

/**
 * x402 client.
 *
 * The interesting property is not that it can pay. It is that the payment is
 * itself a policy-checked action: the client hands the proposed payment back to
 * AgentProof before signing it, so an agent cannot be talked into paying a
 * thousand dollars for a data query by a service that simply asks for it.
 *
 * That closes the loop the demo turns on — an agent pays, under AgentProof
 * policy, for an AgentProof verification.
 */

export interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  resource: string;
  nonce: string;
  maxTimeoutSeconds?: number;
  extra?: { feePayer?: string };
}

export interface PaymentSigner {
  /** Partially signs the Hedera transfer; the facilitator adds gas and submits. */
  signPayment(requirements: PaymentRequirements): Promise<string>;
  accountId(): string;
}

export interface X402ClientOptions {
  http: HttpClient;
  signer: PaymentSigner;
  logger?: Logger;
  /** Called before signing. Returning false aborts the payment. */
  authorise?: (action: Action, requirements: PaymentRequirements) => Promise<boolean>;
  /** Used to build the policy-checkable Action for `authorise`. */
  policyContext?: { facilitator: Address; token: Address; chainId: number };
  /** Hard ceiling independent of policy, as a second belt. */
  maxPricePerCall?: string;
}

export class PaymentRefused extends Error {
  constructor(reason: string) {
    super(`Payment refused: ${reason}`);
    this.name = 'PaymentRefused';
  }
}

export class X402Client {
  constructor(private readonly options: X402ClientOptions) {}

  /**
   * Fetches a paid resource, answering a 402 challenge if one is returned.
   *
   * Deliberately does not retry more than once. An endpoint that answers a
   * signed payment with a second 402 is either broken or malicious, and an
   * agent that keeps paying into that loop is the failure mode this whole
   * project exists to prevent.
   */
  async fetchPaid<T>(url: string, body: unknown): Promise<{ data: T; paid: boolean; transactionId?: string }> {
    const first = await this.attempt(url, body);
    if (first.status !== 402) {
      return { data: (await first.json()) as T, paid: false };
    }

    const challenge = (await first.json()) as { accepts?: PaymentRequirements[] };
    const requirements = challenge.accepts?.[0];
    if (!requirements) throw new PaymentRefused('402 response carried no payment requirements');

    await this.checkPrice(requirements);
    await this.checkPolicy(requirements);

    const payload = await this.options.signer.signPayment(requirements);
    this.options.logger?.log('info', 'answering 402 challenge', {
      amount: requirements.amount,
      network: requirements.network,
      resource: requirements.resource,
    });

    const second = await this.attempt(url, body, payload);
    if (second.status === 402) throw new PaymentRefused('endpoint rejected a signed payment');
    if (!second.ok) throw new Error(`Paid request failed with ${second.status}`);

    const header = second.headers.get('X-PAYMENT-RESPONSE');
    const settlement = header ? JSON.parse(Buffer.from(header, 'base64').toString('utf8')) : undefined;

    return { data: (await second.json()) as T, paid: true, transactionId: settlement?.transaction };
  }

  private async attempt(url: string, body: unknown, payment?: string): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(payment ? { 'X-PAYMENT': payment } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  private async checkPrice(requirements: PaymentRequirements): Promise<void> {
    const ceiling = this.options.maxPricePerCall;
    if (!ceiling) return;
    if (Number(requirements.amount) > Number(ceiling)) {
      throw new PaymentRefused(
        `service asked for ${requirements.amount} but this client's ceiling is ${ceiling} per call`,
      );
    }
  }

  private async checkPolicy(requirements: PaymentRequirements): Promise<void> {
    const { authorise, policyContext } = this.options;
    if (!authorise || !policyContext) return;

    const action = x402PaymentAction({
      facilitator: policyContext.facilitator,
      token: policyContext.token,
      payTo: toEvmAddress(requirements.payTo),
      amount: BigInt(Math.round(Number(requirements.amount) * 1e6)),
      requestId: `0x${requirements.nonce.replace(/-/g, '').padEnd(64, '0').slice(0, 64)}`,
      chainId: policyContext.chainId,
    });

    if (!(await authorise(action, requirements))) {
      throw new PaymentRefused('AgentProof policy declined this payment');
    }
  }
}

/** Maps a Hedera account id (0.0.x) into the address shape the decoder expects. */
function toEvmAddress(accountId: string): Address {
  if (/^0x[0-9a-fA-F]{40}$/.test(accountId)) return accountId.toLowerCase() as Address;
  const num = BigInt(accountId.split('.').pop() ?? '0');
  return `0x${num.toString(16).padStart(40, '0')}` as Address;
}
