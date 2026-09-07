import type { Health, ProofReference, Spend, Verdict } from './types';

/**
 * Client for the Verification API.
 *
 * Everything goes through `/api/*`, which next.config.mjs rewrites to the API.
 * Same-origin, so the HttpOnly session cookie rides along without CORS
 * credentials negotiation.
 *
 * Every call can fail, and the UI is required to say so rather than render a
 * stale value as if it were current. That is why these return a discriminated
 * result instead of throwing: an unreachable API is a state the dashboard
 * displays, not an exception it swallows.
 */

export type Result<T> = { ok: true; value: T } | { ok: false; error: string; status?: number };

async function request<T>(path: string, init?: RequestInit): Promise<Result<T>> {
  try {
    const response = await fetch(`/api${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try {
        const body = (await response.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        /* a non-JSON error body is still an error */
      }
      return { ok: false, error: message, status: response.status };
    }

    return { ok: true, value: (await response.json()) as T };
  } catch (error) {
    const message =
      error instanceof DOMException && error.name === 'TimeoutError'
        ? 'the API did not respond within 10 seconds'
        : 'the API is unreachable';
    return { ok: false, error: message };
  }
}

export const api = {
  health: () => request<Health>('/health'),

  proofs: () => request<{ proofs: ProofReference[]; allProven: boolean }>('/v1/proofs'),

  spend: (account: string) => request<Spend>(`/v1/spend/${account}`),

  policy: (name: string) => request<{ name: string; policy: unknown; policyHash: string }>(`/v1/policy/${encodeURIComponent(name)}`),

  login: (token: string) =>
    request<{ ok: true }>('/v1/dashboard/login', { method: 'POST', body: JSON.stringify({ token }) }),

  /**
   * The dashboard's only control.
   *
   * It resolves an approval the policy engine already escalated; it cannot
   * create one, and it cannot approve anything that was not offered. The
   * dashboard never evaluates policy and never signs.
   */
  approve: (id: string, approved: boolean) =>
    request<{ settled: boolean; error?: string }>('/v1/approve', {
      method: 'POST',
      body: JSON.stringify({ id, approved }),
    }),
};
