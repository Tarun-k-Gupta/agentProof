import { NextRequest } from 'next/server';
import { PaymentRefused, X402Client, hederaSigner } from '@agentproof/x402-client';

/**
 * Verify, proxied by hand and paid for on the way through.
 *
 * Two reasons this is not a `rewrites()` entry like every other route:
 *
 * 1. An escalated action holds the request open until a human answers, and the
 *    rewrite proxy gives up at 30 seconds — a held approval died with a 500
 *    instead of resolving.
 * 2. `/v1/verify` is x402-gated. A browser has no wallet, so from the page it is
 *    simply a 402. Paying here keeps the gate switched on in the demo — the way
 *    it would be in production — instead of turning it off to make the UI work.
 *
 * The payment is a real Hedera settlement against the configured facilitator,
 * and the settlement id comes back to the page so it can be linked to an
 * explorer. If payment is impossible — no keys, facilitator down — the request
 * is still forwarded unpaid, which either succeeds (gate off) or returns the
 * 402 the page knows how to explain. A facilitator outage should degrade the
 * demo, not hang it.
 */

const API = process.env.AGENTPROOF_API_URL ?? 'http://127.0.0.1:8402';

export const dynamic = 'force-dynamic';
// Node runtime: the edge runtime imposes its own response deadline, and the
// Hedera SDK is not edge-safe.
export const runtime = 'nodejs';
export const maxDuration = 300;

function payer() {
  const accountId = process.env.HEDERA_ACCOUNT_ID;
  const privateKey = process.env.HEDERA_PRIVATE_KEY;
  if (!accountId || !privateKey) return undefined;
  return hederaSigner({
    accountId,
    privateKey,
    network: process.env.HEDERA_NETWORK === 'mainnet' ? 'mainnet' : 'testnet',
  });
}

export async function POST(request: NextRequest) {
  const body = await request.text();
  const parsed = JSON.parse(body) as unknown;
  const cookie = request.headers.get('cookie');

  const forward = (payment?: string) =>
    fetch(`${API}/v1/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...(payment ? { 'X-PAYMENT': payment } : {}),
      },
      body,
      // No AbortSignal: the API decides when an unanswered approval expires.
    });

  const signer = payer();

  if (signer) {
    try {
      const client = new X402Client({
        http: { fetch } as never,
        signer,
        // A second belt independent of the server's quoted price, in the same
        // atomic units the challenge quotes — the server converts its display
        // price with toAtomicUnits(price, HEDERA_ASSET_DECIMALS), so a ceiling
        // written in display units silently compares 0.01 against 90 and
        // refuses every call. 1e6 atomic at 8dp is 0.01 display: four orders of
        // magnitude above the 90-unit verify price, and still far below
        // anything worth paying for a policy check.
        maxPricePerCall: process.env.X402_MAX_PRICE_ATOMIC ?? '1000000',
      });

      const { data, paid, transactionId } = await client.fetchPaid<Record<string, unknown>>(
        `${API}/v1/verify`,
        parsed,
      );

      return Response.json({ ...data, settlement: paid ? { paid, transactionId } : undefined });
    } catch (error) {
      // A refused or failed payment is reported, not hidden: the page shows
      // that the verification was not paid for rather than pretending it was.
      const reason = error instanceof PaymentRefused ? error.message : String(error);
      const unpaid = await forward().catch(() => undefined);
      if (!unpaid) {
        return Response.json({ error: `payment failed and the API is unreachable: ${reason}` }, { status: 502 });
      }
      const text = await unpaid.text();
      if (unpaid.status === 402) {
        return Response.json({ error: `this verification could not be paid for: ${reason}` }, { status: 402 });
      }
      return new Response(text, { status: unpaid.status, headers: { 'Content-Type': 'application/json' } });
    }
  }

  try {
    const upstream = await forward();
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'the Verification API is unreachable' },
      { status: 502 },
    );
  }
}
