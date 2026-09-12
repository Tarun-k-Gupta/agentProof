'use client';

import { useEffect, useState } from 'react';
import { PIPELINE, SATELLITES, STAGE_BY_ID, type Stage, type StageId } from '@/lib/deployments';
import { StageDetail } from './StageDetail';

/**
 * The map.
 *
 * The old playground was eight numbered sections stacked vertically, which
 * encodes "here is a list of features". The system is not a list — it is a
 * pipeline with a trust boundary through the middle of it, and that boundary is
 * the single idea a viewer has to leave with. So it is drawn as a literal line:
 * everything left of it is advice an agent may ignore, everything right of it
 * holds whether or not anything off-chain was consulted.
 */
export function ArchitectureMap({ activeStage }: { activeStage?: StageId }) {
  const [open, setOpen] = useState<StageId | undefined>();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="map">
      <div className="map__legend">
        <span className="map__legend-item">
          <span className="map__swatch map__swatch--advisory" />
          <span>
            <strong>Advice</strong> — the AI can ignore all of it
          </span>
        </span>
        <span className="map__legend-item">
          <span className="map__swatch map__swatch--enforcing" />
          <span>
            <strong>Enforced</strong> — holds even if the AI ignores everything
          </span>
        </span>
      </div>

      <div className="map__canvas">
        <div className="map__boundary" aria-hidden="true">
          <span className="map__boundary-label">
            <strong>no trust in the AI needed past here</strong>
          </span>
        </div>

        <div className="map__spine">
          {PIPELINE.map((id, index) => (
            <div className="map__col" key={id}>
              <MapNode
                stage={STAGE_BY_ID[id]}
                active={activeStage === id}
                onOpen={() => setOpen(id)}
                primary
              />
              {index < PIPELINE.length - 1 ? (
                <span className="map__arrow" aria-hidden="true">
                  →
                </span>
              ) : null}

              {(SATELLITES[id] ?? []).length > 0 ? (
                <div className="map__sats">
                  {(SATELLITES[id] ?? []).map((satId) => (
                    <MapNode
                      key={satId}
                      stage={STAGE_BY_ID[satId]}
                      active={activeStage === satId}
                      onOpen={() => setOpen(satId)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      {open ? <StageDetail stage={STAGE_BY_ID[open]} onClose={() => setOpen(undefined)} /> : null}

      <style jsx>{`
        .map {
          display: flex;
          flex-direction: column;
          gap: 20px;
          min-height: 0;
        }
        .map__legend {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          align-items: stretch;
          font-size: var(--text-small);
          color: var(--ink-2);
        }
        .map__legend-item {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          padding: 8px 14px 8px 10px;
          border: 1px solid var(--line);
          border-radius: var(--radius-pill);
          background: var(--bg);
        }
        .map__legend-item :global(strong) {
          font-weight: 600;
          color: var(--ink);
        }
        .map__swatch {
          width: 14px;
          height: 14px;
          border-radius: 4px;
          border: 1.5px solid var(--line-2);
          flex: none;
        }
        .map__swatch--advisory {
          background: var(--bg-3);
          border-style: dashed;
        }
        .map__swatch--enforcing {
          background: var(--teal);
          border-color: var(--teal-strong);
        }

        .map__canvas {
          position: relative;
          border: 1px solid var(--line);
          border-radius: var(--radius-lg);
          background:
            radial-gradient(100% 120% at 78% 0%, var(--teal-bg) 0%, transparent 52%),
            var(--bg-2);
          padding: 56px 30px 36px;
          overflow-x: auto;
        }

        /* The boundary sits between spine column 3 (policy) and 4 (hook). With
           five equal columns that is exactly 60% across. */
        .map__boundary {
          position: absolute;
          top: 0;
          bottom: 0;
          left: 60%;
          width: 0;
          border-left: 2px solid var(--teal);
          pointer-events: none;
          display: flex;
          justify-content: center;
          z-index: 2;
        }
        .map__boundary-label {
          position: absolute;
          top: 14px;
          transform: translateX(-50%);
          left: 0;
          white-space: nowrap;
          font-size: var(--text-caption);
          color: #fff;
          background: var(--teal);
          padding: 5px 14px;
          border-radius: var(--radius-pill);
          box-shadow: var(--shadow-teal);
        }
        .map__boundary-label :global(strong) {
          font-weight: 600;
        }

        .map__spine {
          display: grid;
          grid-template-columns: repeat(5, minmax(190px, 1fr));
          gap: 0;
          align-items: start;
          min-width: 1080px;
        }
        .map__col {
          position: relative;
          padding: 0 10px;
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        .map__arrow {
          position: absolute;
          top: 40px;
          right: -9px;
          color: var(--ink-4);
          font-size: 18px;
          z-index: 1;
          background: var(--bg-2);
          line-height: 1;
        }
        .map__sats {
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding-left: 14px;
          border-left: 1px solid var(--line-2);
          margin-left: 12px;
        }
      `}</style>
    </div>
  );
}

function MapNode({
  stage,
  onOpen,
  primary,
  active,
}: {
  stage: Stage;
  onOpen: () => void;
  primary?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`node node--${stage.side} ${primary ? 'node--primary' : ''} ${active ? 'node--active' : ''}`}
    >
      <span className="node__name">{stage.plainName}</span>
      <span className="node__plain">{stage.plain}</span>
      <span className="node__tech">{stage.name}</span>

      <style jsx>{`
        .node {
          text-align: left;
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 13px 15px;
          border-radius: var(--radius-sm);
          background: var(--card);
          border: 1px solid var(--line-2);
          cursor: pointer;
          font: inherit;
          color: inherit;
          transition:
            transform var(--dur-2) var(--ease-spring),
            box-shadow var(--dur-2) var(--ease-out),
            border-color var(--dur-1) var(--ease-out);
        }
        .node--primary {
          padding: 18px 18px 16px;
          border-radius: var(--radius);
          box-shadow: var(--shadow-1);
        }
        .node--advisory {
          border-style: dashed;
        }
        .node--enforcing {
          border-color: var(--teal-line);
          border-style: solid;
          box-shadow: inset 4px 0 0 var(--teal), var(--shadow-1);
        }
        .node:hover {
          transform: translateY(-3px);
          box-shadow: var(--shadow-2);
          border-color: var(--teal);
        }
        .node--enforcing:hover {
          box-shadow: inset 4px 0 0 var(--teal), var(--shadow-teal);
        }
        .node::after {
          content: 'Details →';
          font-family: var(--font-mono);
          font-size: 10px;
          letter-spacing: var(--tracking-wide);
          text-transform: uppercase;
          color: var(--teal-ink);
          opacity: 0;
          transition: opacity var(--dur-1) var(--ease-out);
          margin-top: 4px;
        }
        .node:hover::after,
        .node:focus-visible::after {
          opacity: 1;
        }
        .node--active {
          border-color: var(--gold);
          box-shadow: 0 0 0 3px var(--gold-bg);
        }
        .node__name {
          font-family: var(--font-display);
          font-weight: 700;
          font-size: var(--text-h3);
          letter-spacing: var(--tracking-tight);
          line-height: 1.2;
        }
        .node__plain {
          font-size: var(--text-caption);
          color: var(--ink-2);
          line-height: 1.5;
        }
        /* The term of art, kept but subordinated — it is a label for the plain
           sentence above it, not the thing a newcomer has to decode first. */
        .node__tech {
          margin-top: 2px;
          font-family: var(--font-mono);
          font-size: 10.5px;
          letter-spacing: var(--tracking-wide);
          text-transform: uppercase;
          color: var(--ink-4);
        }
        @media (prefers-reduced-motion: reduce) {
          .node:hover {
            transform: none;
          }
        }
      `}</style>
    </button>
  );
}
