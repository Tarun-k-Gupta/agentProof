'use client';

import type { Decision, ProofStatus, Provenance } from '@/lib/types';

/** Decision chip. The single most-read pixel on the page. */
export function DecisionChip({ decision, size = 'md' }: { decision: Decision; size?: 'sm' | 'md' }) {
  const label = decision === 'REQUIRE_APPROVAL' ? 'NEEDS APPROVAL' : decision;
  const tone = decision === 'ALLOW' ? 'allow' : decision === 'BLOCK' ? 'block' : 'approval';
  return (
    <span className={`chip chip-${tone} chip-${size}`}>
      <span className="chip-dot" aria-hidden="true" />
      {label}
      <style jsx>{`
        .chip {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          border-radius: 999px;
          font-weight: 650;
          letter-spacing: 0.02em;
          white-space: nowrap;
          border: 1px solid;
        }
        .chip-md { padding: 4px 11px 4px 9px; font-size: 12px; }
        .chip-sm { padding: 2px 8px 2px 6px; font-size: 11px; }
        .chip-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
        .chip-allow { color: var(--teal-ink); background: var(--teal-bg); border-color: var(--teal-line); }
        .chip-block { color: var(--red); background: var(--red-bg); border-color: var(--red-line); }
        .chip-approval { color: var(--amber); background: var(--amber-bg); border-color: var(--amber-line); }
      `}</style>
    </span>
  );
}

/**
 * Provenance tag.
 *
 * PRD 5.1: a limit is meaningless unless the number it compares against comes
 * from the transaction. Showing where each number came from is what makes that
 * claim checkable by a reader rather than asserted by a README.
 */
export function ProvenanceTag({ provenance }: { provenance?: Provenance }) {
  if (!provenance) return null;
  const title = {
    DECLARED: 'The agent said so. Never trusted on-chain.',
    DECODED: 'Parsed from calldata by a known-selector decoder.',
    MEASURED: 'The account’s own balance delta. Authoritative.',
  }[provenance];

  return (
    <span className={`prov prov-${provenance.toLowerCase()}`} title={title}>
      {provenance}
      <style jsx>{`
        .prov {
          font-family: var(--mono);
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.04em;
          padding: 1px 5px;
          border-radius: 4px;
          border: 1px solid var(--line);
          color: var(--ink-3);
          background: var(--bg-2);
          cursor: help;
        }
        .prov-measured { color: var(--teal-ink); border-color: var(--teal-line); background: var(--teal-bg); }
        .prov-declared { color: var(--red); border-color: var(--red-line); background: var(--red-bg); }
      `}</style>
    </span>
  );
}

/** Proof badge. Never says PROVEN unless an artifact says so. */
export function ProofBadge({ status, detail }: { status: ProofStatus; detail?: string }) {
  const tone = status === 'PROVEN' ? 'proven' : status === 'COUNTEREXAMPLE' ? 'counter' : 'unknown';
  return (
    <span className={`badge badge-${tone}`} title={detail}>
      {status === 'PROVEN' ? '✓' : status === 'COUNTEREXAMPLE' ? '✗' : '○'} {status.replace('_', ' ')}
      <style jsx>{`
        .badge {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-family: var(--mono);
          font-size: 10.5px;
          font-weight: 600;
          padding: 2px 7px;
          border-radius: 5px;
          border: 1px solid var(--line);
          color: var(--ink-3);
          background: var(--bg-2);
          white-space: nowrap;
        }
        .badge-proven { color: var(--teal-ink); border-color: var(--teal-line); background: var(--teal-bg); }
        .badge-counter { color: var(--red); border-color: var(--red-line); background: var(--red-bg); }
      `}</style>
    </span>
  );
}

export function Panel({
  title,
  subtitle,
  action,
  children,
  live,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  live?: boolean;
}) {
  return (
    <section className="panel" aria-label={title}>
      <header className="panel-head">
        <div>
          <h2 className="panel-title">{title}</h2>
          {subtitle ? <p className="panel-sub">{subtitle}</p> : null}
        </div>
        {action}
      </header>
      <div className="panel-body" {...(live ? { 'aria-live': 'polite' as const, 'aria-relevant': 'additions text' as const } : {})}>
        {children}
      </div>
      <style jsx>{`
        .panel { display: flex; flex-direction: column; min-height: 0; height: 100%; }
        .panel-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
          padding: 16px 20px 12px;
          border-bottom: 1px solid var(--line);
          flex: 0 0 auto;
        }
        .panel-title {
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.07em;
          text-transform: uppercase;
          color: var(--ink-3);
        }
        .panel-sub { font-size: 12.5px; color: var(--ink-4); margin-top: 2px; }
        .panel-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 16px 20px 24px; }
      `}</style>
    </section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="empty">
      {children}
      <style jsx>{`
        .empty {
          color: var(--ink-4);
          font-size: 13px;
          padding: 22px 0;
          text-align: center;
        }
      `}</style>
    </p>
  );
}

/** A labelled key/value line, used everywhere in the enforcement pane. */
export function Field({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{children}</dd>
      <style jsx>{`
        .field {
          display: grid;
          grid-template-columns: 118px 1fr;
          gap: 12px;
          padding: 5px 0;
          align-items: baseline;
        }
        dt { color: var(--ink-4); font-size: 12px; }
        dd { margin: 0; color: var(--ink); word-break: break-word; min-width: 0; }
        @media (max-width: 560px) {
          .field { grid-template-columns: 1fr; gap: 2px; }
        }
      `}</style>
    </div>
  );
}
