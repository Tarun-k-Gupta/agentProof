import type { HttpClient } from '@agentproof/sdk';

/**
 * The only outbound HTTP the API makes: facilitator calls and subgraph queries.
 *
 * Timeouts are mandatory rather than optional. A verification service that
 * hangs because a facilitator is slow is a verification service that is down,
 * and an agent waiting on it will either stall or — worse, if someone adds a
 * fallback later — proceed without an answer.
 */
export const fetchHttpClient: HttpClient = {
  async postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
    return request<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  },

  async getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
    return request<T>(url, { method: 'GET', headers });
  },
};

async function request<T>(url: string, init: RequestInit, timeoutMs = 10_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${init.method ?? 'GET'} ${redactUrl(url)} failed with ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Query strings can carry API keys; error messages should not. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[unparseable-url]';
  }
}
