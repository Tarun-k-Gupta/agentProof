'use client';

import { useEffect, useRef } from 'react';
import type { Stage } from '@/lib/deployments';

/**
 * What a viewer gets when they click a node.
 *
 * Deliberately shaped as claim + counter-claim: every stage states what it
 * guarantees *and* what it cannot do. A security UI that only lists strengths
 * is marketing, and the limits are the part that makes the boundary legible.
 */
export function StageDetail({ stage, onClose }: { stage: Stage; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.focus();
  }, [stage.id]);

  return (
    <div className="scrim" onClick={onClose} role="presentation">
      <aside
        className="sheet"
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={stage.name}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="sheet__head">
          <div>
            <span className={`ap-chip ${stage.side === 'enforcing' ? 'ap-chip--allow' : ''}`}>
              {stage.side === 'enforcing' ? 'on-chain · enforcing' : 'off-chain · advisory'}
            </span>
            <h2>{stage.plainName}</h2>
            <p className="sheet__plain">{stage.plain}</p>
            <p className="sheet__q">
              <span className="ap-mono">{stage.name}</span> · {stage.question}
            </p>
          </div>
          <button type="button" className="ap-btn ap-btn--ghost" onClick={onClose} aria-label="Close">
            Esc ✕
          </button>
        </header>

        <p className="sheet__what">{stage.what}</p>

        <section className="sheet__claim sheet__claim--yes">
          <span className="sheet__claim-label">What you can rely on</span>
          <p>{stage.guarantee}</p>
        </section>

        <section className="sheet__claim sheet__claim--no">
          <span className="sheet__claim-label">What it does not do</span>
          <p>{stage.limit}</p>
        </section>

        <section className="sheet__artifacts">
          <span className="sheet__claim-label">Deployed / real</span>
          <dl>
            {stage.artifacts.map((artifact, index) => (
              <div key={`${artifact.label}-${index}`} className="sheet__row">
                <dt>{artifact.label}</dt>
                <dd className={artifact.mono ? 'ap-mono' : undefined}>
                  {artifact.href ? (
                    <a href={artifact.href} target="_blank" rel="noreferrer noopener">
                      {artifact.value} ↗
                    </a>
                  ) : (
                    artifact.value
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </aside>

      <style jsx>{`
        .scrim {
          position: fixed;
          inset: 0;
          background: rgba(10, 20, 40, 0.38);
          backdrop-filter: blur(2px);
          display: flex;
          justify-content: flex-end;
          z-index: 50;
          animation: fade var(--dur-2) var(--ease-out);
        }
        .sheet {
          width: min(560px, 100vw);
          height: 100%;
          overflow-y: auto;
          background: var(--bg);
          border-left: 1px solid var(--line);
          padding: 26px 28px 48px;
          display: flex;
          flex-direction: column;
          gap: 20px;
          box-shadow: var(--shadow-2);
          animation: slide var(--dur-2) var(--ease-out);
        }
        .sheet__head {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 16px;
        }
        .sheet__head h2 {
          font-family: var(--font-display);
          font-size: var(--text-h1);
          font-weight: 800;
          letter-spacing: var(--tracking-tight);
          margin-top: 10px;
        }
        .sheet__plain {
          margin-top: 8px;
          font-size: var(--text-h3);
          line-height: var(--leading-body);
          color: var(--ink);
          max-width: 46ch;
        }
        .sheet__q {
          color: var(--ink-3);
          font-size: var(--text-caption);
          margin-top: 10px;
          padding-top: 10px;
          border-top: 1px solid var(--line);
        }
        .sheet__what {
          font-size: var(--text-h3);
          line-height: var(--leading-body);
          color: var(--ink-2);
          max-width: 60ch;
        }
        .sheet__claim {
          border-left: 3px solid var(--line-2);
          padding: 2px 0 2px 14px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .sheet__claim--yes {
          border-color: var(--teal);
        }
        .sheet__claim--no {
          border-color: var(--amber);
        }
        .sheet__claim p {
          font-size: var(--text-small);
          line-height: var(--leading-body);
          color: var(--ink-2);
          max-width: 62ch;
        }
        .sheet__claim-label {
          font-family: var(--font-mono);
          font-size: var(--text-caption);
          letter-spacing: var(--tracking-wide);
          text-transform: uppercase;
          color: var(--ink-4);
        }
        .sheet__artifacts {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .sheet__row {
          display: grid;
          grid-template-columns: 128px 1fr;
          gap: 12px;
          padding: 9px 0;
          border-bottom: 1px solid var(--line);
          font-size: var(--text-small);
          align-items: baseline;
        }
        .sheet__row:last-child {
          border-bottom: 0;
        }
        .sheet__row dt {
          color: var(--ink-3);
        }
        .sheet__row dd {
          overflow-wrap: anywhere;
        }
        @keyframes slide {
          from {
            transform: translateX(24px);
            opacity: 0;
          }
        }
        @keyframes fade {
          from {
            opacity: 0;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .sheet,
          .scrim {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
}
