import type { Logger } from '@agentproof/sdk';
import type { PaymentRequirements, PaymentSigner } from './index.ts';

/**
 * Real x402 v2 Hedera signer, built on the official @x402/hedera
 * ExactHederaScheme.
 *
 * The scheme builds the partially-signed TransferTransaction the Blocky402
 * facilitator settles (it co-signs as fee-payer, pays gas and submits). We
 * never hold anyone else's key and never submit ourselves. The payload is
 * then carried in OUR X-PAYMENT header so the policy gate in X402Client —
 * price ceiling, AgentProof check, single-attempt discipline — still applies.
 */
export function hederaSigner(options: {
  accountId: string;
  privateKey: string;
  network?: 'testnet' | 'mainnet';
  logger?: Logger;
}): PaymentSigner {
  return {
    accountId: () => options.accountId,

    async signPayment(requirements: PaymentRequirements): Promise<string> {
      const { createClientHederaSigner } = await import('@x402/hedera');
      const { ExactHederaScheme } = await import('@x402/hedera');
      const { PrivateKey } = await import('@x402/hedera');

      const amount = BigInt(requirements.amount);
      if (amount <= 0n) throw new Error(`Refusing to sign a non-positive payment: ${requirements.amount}`);

      const signer = createClientHederaSigner(
        options.accountId,
        PrivateKey.fromStringECDSA(options.privateKey),
        { network: options.network === 'mainnet' ? 'hedera:mainnet' : 'hedera:testnet' },
      );
      const scheme = new ExactHederaScheme(signer);

      // The facilitator compares this snapshot against the challenge, so it
      // carries exactly what the server sent (feePayer included).
      // createPaymentPayload returns only the signed payload part; the
      // v2 envelope (scheme/network/accepted) is composed by the caller —
      // same as @x402/fetch does. `accepted` mirrors the challenge so the
      // facilitator can compare it against what the server asked for.
      const result = (await scheme.createPaymentPayload(2, {
        scheme: 'exact',
        network: requirements.network as `${string}:${string}`,
        amount: requirements.amount,
        payTo: requirements.payTo,
        maxTimeoutSeconds: requirements.maxTimeoutSeconds ?? 60,
        asset: requirements.asset,
        extra: { feePayer: requirements.extra?.feePayer ?? '' },
      })) as { payload?: unknown };

      const envelope = {
        x402Version: 2,
        scheme: requirements.scheme,
        network: requirements.network,
        accepted: {
          scheme: 'exact',
          network: requirements.network,
          amount: requirements.amount,
          payTo: requirements.payTo,
          maxTimeoutSeconds: requirements.maxTimeoutSeconds ?? 60,
          asset: requirements.asset,
          extra: { feePayer: requirements.extra?.feePayer ?? '' },
        },
        payload: result.payload ?? result,
      };

      options.logger?.log('info', 'signed x402 payment', {
        amount: requirements.amount,
        asset: requirements.asset,
        payTo: requirements.payTo,
      });

      return Buffer.from(JSON.stringify(envelope)).toString('base64');
    },
  };
}
