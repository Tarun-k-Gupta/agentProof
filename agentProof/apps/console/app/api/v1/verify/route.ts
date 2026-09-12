import { NextRequest } from 'next/server';

/**
 * Verify, proxied by hand rather than by a rewrite.
 *
 * An escalated action holds this request open until a human answers, and the
 * `rewrites()` proxy gives up at 30 seconds — a held approval died with a 500
 * instead of resolving. A route handler owns the connection for as long as the
 * API needs it, so the approval deadline is the API's to enforce, not Next's.
 *
 * Everything else still goes through the rewrite; only this one route needs to
 * outlive it.
 */

const API = process.env.AGENTPROOF_API_URL ?? 'http://127.0.0.1:8402';

export const dynamic = 'force-dynamic';
// Node runtime: the edge runtime imposes its own response deadline.
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const body = await request.text();

  try {
    const upstream = await fetch(`${API}/v1/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Carried through so the API sees the same session it would have seen
        // behind the rewrite.
        ...(request.headers.get('cookie') ? { cookie: request.headers.get('cookie')! } : {}),
      },
      body,
      // No AbortSignal: the API decides when an unanswered approval expires.
    });

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
