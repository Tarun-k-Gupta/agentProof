'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalRequest, Thought, Verdict } from './types';

export type ConnectionState = 'connecting' | 'open' | 'unauthorized' | 'closed';

export interface StreamState {
  connection: ConnectionState;
  decisions: Verdict[];
  thoughts: Thought[];
  approvals: ApprovalRequest[];
  /** Approvals resolved in this session, so the UI can show what happened. */
  resolved: Record<string, 'approved' | 'declined' | 'expired'>;
}

/** How long an escalated approval stays actionable before the UI marks it stale. */
const APPROVAL_TTL_MS = 5 * 60 * 1000;
const MAX_ITEMS = 50;

/**
 * Subscribes to the API's server-sent event stream.
 *
 * Reconnects with backoff, because a dashboard that silently stops updating is
 * worse than one that says it is disconnected — an operator watching a stale
 * "0 spent today" has no way to know it is stale.
 *
 * A 401 is terminal rather than retried: the stream is owner-only, and hammering
 * it without a session just fills the API's logs.
 */
export function useStream(enabled: boolean): StreamState & { markResolved: (id: string, how: 'approved' | 'declined') => void } {
  const [connection, setConnection] = useState<ConnectionState>('closed');
  const [decisions, setDecisions] = useState<Verdict[]>([]);
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [resolved, setResolved] = useState<Record<string, 'approved' | 'declined' | 'expired'>>({});
  const attemptRef = useRef(0);

  const markResolved = useCallback((id: string, how: 'approved' | 'declined') => {
    setResolved((previous) => ({ ...previous, [id]: how }));
    setApprovals((previous) => previous.filter((request) => request.id !== id));
  }, []);

  useEffect(() => {
    if (!enabled) {
      setConnection('closed');
      return;
    }

    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      setConnection('connecting');
      source = new EventSource('/api/v1/stream', { withCredentials: true });

      source.onopen = () => {
        attemptRef.current = 0;
        setConnection('open');
      };

      // The API writes named SSE events — `event: decision`, `event: thought`,
      // `event: approval` — with the payload alone in `data`. Named events do
      // not reach `onmessage`, which fires only for unnamed frames; listening
      // there instead is a stream that connects, stays open, and shows nothing.
      const on = <T,>(name: string, handle: (payload: T) => void) => {
        source?.addEventListener(name, (event) => {
          try {
            handle(JSON.parse((event as MessageEvent<string>).data) as T);
          } catch {
            // A malformed frame is not worth tearing the stream down for.
          }
        });
      };

      on<Verdict>('decision', (verdict) => {
        setDecisions((previous) => [verdict, ...previous].slice(0, MAX_ITEMS));
      });

      on<string | Thought>('thought', (payload) => {
        const thought: Thought = typeof payload === 'string' ? { at: Date.now(), text: payload } : payload;
        setThoughts((previous) => [thought, ...previous].slice(0, MAX_ITEMS));
      });

      on<ApprovalRequest>('approval', (request) => {
        setApprovals((previous) => [
          { ...request, expiresAt: request.expiresAt ?? Date.now() + APPROVAL_TTL_MS },
          ...previous.filter((existing) => existing.id !== request.id),
        ]);
      });

      source.onerror = () => {
        source?.close();
        if (cancelled) return;

        // EventSource does not expose the status code. A connection that never
        // opened is almost always the 401 from a missing session; one that
        // opened and dropped is a restart worth retrying.
        if (attemptRef.current === 0 && connectionNeverOpened()) {
          setConnection('unauthorized');
          return;
        }

        attemptRef.current += 1;
        const delay = Math.min(1000 * 2 ** attemptRef.current, 15_000);
        setConnection('closed');
        retry = setTimeout(connect, delay);
      };

      function connectionNeverOpened(): boolean {
        return source?.readyState === EventSource.CLOSED && attemptRef.current === 0;
      }
    };

    connect();

    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, [enabled]);

  // Age out approvals nobody acted on, rather than leaving a button that will
  // 404 when pressed.
  useEffect(() => {
    if (approvals.length === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setApprovals((previous) => {
        const live = previous.filter((request) => (request.expiresAt ?? 0) > now);
        if (live.length !== previous.length) {
          const expired = previous.filter((request) => (request.expiresAt ?? 0) <= now);
          setResolved((r) => ({ ...r, ...Object.fromEntries(expired.map((e) => [e.id, 'expired' as const])) }));
        }
        return live;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [approvals.length]);

  return { connection, decisions, thoughts, approvals, resolved, markResolved };
}
