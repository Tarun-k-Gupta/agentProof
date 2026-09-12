import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Logger } from '@agentproof/sdk';
import { type Facilitator, type PaymentRequirements, type SettlementResult } from './blocky402.ts';
import { ReplayGuard } from './replay.ts';

export interface X402Options {
  facilitator: Facilitator;
  network: string;
  asset: string;
  payTo: string;
  /** price per call, in the asset's display units, e.g. '0.01' */
  price: string;
  /** decimals of the priced asset (HBAR 8, USDC 6): converts price to atomic units */
  assetDecimals: number;
  /** passthrough for chains whose facilitator needs it (Hedera feePayer) */
  extra?: { feePayer?: string };
  baseUrl: string;
  logger?: Logger;
  /** disables gating entirely; used only for local development */
  enabled: boolean;
  /** shared across routes so a payload paid for /v1/decode cannot be replayed at /v1/verify */
  replay?: ReplayGuard;
}

/**
 * x402 gating.
 *
 * Two ordering decisions carry the whole design:
 *
 *   verify BEFORE the work — so an invalid payload costs us nothing
 *   settle AFTER the work  — so a caller is never charged for a request that
 *                            failed. Settling first would be simpler and would
 *                            quietly turn every outage into revenue.
 *
 * The framing that matters more than either: this endpoint is advisory L1 for
 * agents that cannot embed the SDK. An HTTP "is this safe?" service is, on its
 * own, exactly the bypassable application-level guardrail this project argues
 * against. The boundary is the on-chain hook. Say so in the README, in the
 * video, and here.
 */
export function createX402Gate(options: X402Options) {
  const replay = options.replay ?? new ReplayGuard();

  return async function gate(
    req: IncomingMessage,
    res: ServerResponse,
    resource: string,
    work: () => Promise<unknown>,
    /**
     * Runs once the payment outcome is known. The audit record is written here
     * rather than inside `work` so the trail records what was actually settled,
     * not what we hoped would settle.
     */
    afterSettlement?: (result: unknown, settlement: SettlementResult) => void,
  ): Promise<void> {
    if (!options.enabled) {
      const result = await work();
      afterSettlement?.(result, { settled: false, reason: 'x402 disabled' });
      await respondJson(res, 200, result);
      return;
    }

    const requirements: PaymentRequirements = {
      scheme: 'exact',
      network: options.network,
      asset: options.asset,
      amount: toAtomicUnits(options.price, options.assetDecimals),
      payTo: options.payTo,
      resource: `${options.baseUrl}${resource}`,
      description: 'AgentProof policy verification, metered per call',
      maxTimeoutSeconds: 60,
      facilitator: 'blocky402',
      nonce: randomUUID(),
      ...(options.extra ? { extra: options.extra } : {}),
    };

    const header = req.headers['x-payment'];
    if (typeof header !== 'string' || header.length === 0) {
      await challenge(res, requirements, 'Payment required');
      return;
    }

    // Malformed payloads are rejected here rather than at the facilitator, so a
    // caller gets a diagnosable answer and we do not spend a round trip on a
    // header that could never have been valid.
    if (!isWellFormedPayment(header)) {
      await challenge(res, requirements, 'X-PAYMENT header is not base64-encoded JSON');
      return;
    }

    // Claimed before verification, so two concurrent requests carrying the same
    // payload cannot both pass the check and both do the work.
    if (!replay.claim(header)) {
      await challenge(res, requirements, 'This payment payload has already been used; obtain a new one');
      return;
    }

    let verification: { valid: boolean; reason?: string };
    try {
      verification = await options.facilitator.verify(header, requirements);
    } catch (error) {
      // A facilitator that times out or errors is our outage, not the caller's.
      // Release the claim so the same payment can be retried.
      replay.release(header);
      options.logger?.log('warn', 'facilitator verify failed', { error: String(error) });
      await respondJson(res, 503, { error: 'payment facilitator unavailable', retryable: true });
      return;
    }

    if (!verification.valid) {
      replay.release(header);
      await challenge(res, requirements, verification.reason ?? 'Payment verification failed');
      return;
    }

    let result: unknown;
    try {
      result = await work();
    } catch (error) {
      // Never settle for work we did not deliver, and let the caller reuse the
      // payment they already made.
      replay.release(header);
      throw error;
    }

    let settlement: SettlementResult;
    try {
      settlement = await options.facilitator.settle(header, requirements);
    } catch (error) {
      settlement = { settled: false, reason: error instanceof Error ? error.message : String(error) };
    }

    if (!settlement.settled) {
      // The work is done and correct; we simply were not paid for it. Returning
      // an error here would withhold an answer the caller is entitled to and
      // invite a retry that does the work a second time. We hand over the result
      // and report the failure in the payment response header and the log.
      options.logger?.log('warn', 'work completed but settlement failed', { reason: settlement.reason });
    }

    afterSettlement?.(result, settlement);

    res.setHeader(
      'X-PAYMENT-RESPONSE',
      Buffer.from(
        JSON.stringify({
          success: settlement.settled,
          transaction: settlement.transactionId,
          error: settlement.settled ? undefined : (settlement.reason ?? 'settlement failed'),
        }),
      ).toString('base64'),
    );
    await respondJson(res, 200, result);
  };
}

async function challenge(res: ServerResponse, requirements: PaymentRequirements, error: string): Promise<void> {
  await respondJson(res, 402, { x402Version: 1, error, accepts: [requirements] });
}

/** Display units (e.g. '0.01') to atomic units ('1000000' at 8 decimals). */
export function toAtomicUnits(display: string, decimals: number): string {
  const [whole = '0', frac = ''] = display.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0')).toString();
}

function isWellFormedPayment(header: string): boolean {  try {
    JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    return true;
  } catch {
    return false;
  }
}

export async function respondJson(res: ServerResponse, status: number, body: unknown): Promise<void> {
  const payload = JSON.stringify(body, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    // The API is stateless and holds nothing; say so in headers too.
    'X-AgentProof-Stateless': 'true',
  });
  res.end(payload);
}
