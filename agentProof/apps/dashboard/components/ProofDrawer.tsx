'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { ProofReference } from '@/lib/types';
import { ProofBadge } from './primitives';

/**
 * Proof drawer.
 *
 * PRD 9.5: showing the counterexample the solver produced for the deliberately
 * broken spec is worth more than two green checkmarks, because it is the only
 * evidence a reader has that the checker ran at all. So the drawer renders both,
 * and it renders NOT_RUN plainly when nobody has run the verifier — a proof
 * status invented by a UI is worse than no proof status.
 */
export function ProofDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [proofs, setProofs] = useState<ProofReference[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void api.proofs().then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result.ok) {
        setProofs(result.value.proofs);
        setError(undefined);
      } else {
        setError(result.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="scrim" onClick={onClose} role="presentation">
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Formal verification results"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2>Formal verification</h2>
            <p>
              solc SMTChecker, CHC engine. The proof covers <code>PolicyLib.evaluate</code> — the pure policy
              arithmetic — not the hook, which is fuzz-tested instead.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close proof drawer">
            ✕
          </button>
        </header>

        <div className="body">
          {loading ? <p className="muted">Loading proof artifacts…</p> : null}
          {error ? <p className="error">Could not read proofs: {error}</p> : null}

          {!loading && !error && proofs.length === 0 ? (
            <p className="muted">
              No proof artifacts. Run <code>pnpm verify:formal</code> to produce them.
            </p>
          ) : null}

          {proofs.map((proof) => (
            <article key={proof.property} className="proof">
              <div className="proof-head">
                <h3>{proof.property}</h3>
                <ProofBadge status={proof.status} />
              </div>
              <dl>
                <div>
                  <dt>Tool</dt>
                  <dd className="mono">{proof.tool}</dd>
                </div>
                <div>
                  <dt>Solver time</dt>
                  <dd className="tabular">{proof.solverTimeMs.toLocaleString('en-US')} ms</dd>
                </div>
                <div>
                  <dt>Artifact</dt>
                  <dd className="mono">{proof.artifactPath}</dd>
                </div>
              </dl>
              {proof.counterexample ? (
                <>
                  <h4>Counterexample</h4>
                  <pre>{proof.counterexample}</pre>
                </>
              ) : null}
            </article>
          ))}

          <p className="footnote">
            A proof holds for the specification we wrote, under the model checked. SMTChecker can return{' '}
            <em>unknown</em>; when it does, this reads UNPROVEN rather than claiming success.
          </p>
        </div>
      </aside>

      <style jsx>{`
        .scrim {
          position: fixed;
          inset: 0;
          background: rgba(11, 18, 32, 0.42);
          display: flex;
          justify-content: flex-end;
          z-index: 40;
          animation: fade 160ms ease-out;
        }
        .drawer {
          width: min(560px, 100%);
          height: 100%;
          background: var(--bg);
          border-left: 1px solid var(--line);
          box-shadow: var(--shadow-2);
          display: flex;
          flex-direction: column;
          animation: slide 220ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        header {
          display: flex;
          gap: 16px;
          align-items: flex-start;
          justify-content: space-between;
          padding: 20px 22px 16px;
          border-bottom: 1px solid var(--line);
        }
        h2 { font-size: 15px; font-weight: 650; }
        header p { font-size: 12.5px; color: var(--ink-3); margin-top: 4px; max-width: 46ch; }
        header button {
          min-width: 44px;
          min-height: 44px;
          border: 1px solid var(--line);
          background: var(--bg-2);
          border-radius: var(--radius-sm);
          cursor: pointer;
          color: var(--ink-3);
        }
        header button:hover { background: var(--bg-3); color: var(--ink); }
        .body { padding: 18px 22px 28px; overflow-y: auto; display: flex; flex-direction: column; gap: 18px; }
        .proof {
          border: 1px solid var(--line);
          border-radius: var(--radius);
          padding: 14px 16px;
          background: var(--bg-2);
        }
        .proof-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        h3 { font-family: var(--mono); font-size: 13px; font-weight: 650; }
        dl { margin: 10px 0 0; display: flex; flex-direction: column; gap: 3px; }
        dl > div { display: grid; grid-template-columns: 96px 1fr; gap: 10px; font-size: 12.5px; }
        dt { color: var(--ink-4); }
        dd { margin: 0; color: var(--ink-2); }
        h4 {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--ink-4);
          margin: 14px 0 6px;
        }
        pre {
          margin: 0;
          padding: 12px;
          background: var(--bg);
          border: 1px solid var(--line);
          border-radius: var(--radius-sm);
          font-family: var(--mono);
          font-size: 11.5px;
          line-height: 1.6;
          color: var(--ink-2);
          overflow-x: auto;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .muted { color: var(--ink-4); font-size: 13px; }
        .error { color: var(--red); font-size: 13px; }
        .footnote { font-size: 12px; color: var(--ink-4); border-top: 1px solid var(--line); padding-top: 14px; }
        code { font-family: var(--mono); font-size: 0.92em; background: var(--bg-3); padding: 1px 4px; border-radius: 4px; }
        @keyframes fade { from { opacity: 0; } }
        @keyframes slide { from { transform: translateX(24px); opacity: 0; } }
      `}</style>
    </div>
  );
}
