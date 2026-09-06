import type { ServerResponse } from 'node:http';

/**
 * Server-sent events for the dashboard.
 *
 * One-way by construction. There is no channel from a browser back into a
 * policy outcome, which is the answer to "what happens if I close the
 * dashboard": nothing changes. The engine runs in the agent's process and the
 * hook runs on the account; this is a window, not a control.
 *
 * The one exception is approval, which is a deliberate, separate POST route
 * guarded by an id the server issued — see routes/approve.
 */
export interface StreamEvent {
  type: 'decision' | 'thought' | 'approval';
  data: unknown;
}

export class EventStream {
  private readonly clients = new Set<ServerResponse>();
  private readonly recent: StreamEvent[] = [];
  private readonly backlog: number;

  constructor(options: { backlog?: number } = {}) {
    this.backlog = options.backlog ?? 50;
  }

  /** Attaches a client and replays recent events so a late tab is not blank. */
  subscribe(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(': connected\n\n');

    for (const event of this.recent) this.write(res, event);
    this.clients.add(res);

    // Comment frames keep proxies from closing an idle stream mid-demo.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    res.on('close', () => {
      clearInterval(heartbeat);
      this.clients.delete(res);
    });
  }

  publish(event: StreamEvent): void {
    this.recent.push(event);
    if (this.recent.length > this.backlog) this.recent.shift();
    for (const client of this.clients) this.write(client, event);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private write(res: ServerResponse, event: StreamEvent): void {
    const payload = JSON.stringify(event.data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    res.write(`event: ${event.type}\ndata: ${payload}\n\n`);
  }
}
