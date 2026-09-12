'use client';

import { useState } from 'react';
import { INTEGRATIONS, STATUS_COPY, type Integration } from '@/lib/integrations';

/**
 * The stack, stated outright.
 *
 * Not a logo wall. Each protocol gets the one non-obvious thing we do with it,
 * because "we integrated Uniswap" is a claim anybody can make and "exact-output
 * binds on amountInMaximum, never the quote" is one you can check.
 */
export function Integrations() {
  const [open, setOpen] = useState<string>(INTEGRATIONS[0].name);

  return (
    <div className="ix">
      <ul className="ix__list">
        {INTEGRATIONS.map((integration) => (
          <IntegrationRow
            key={integration.name}
            integration={integration}
            open={open === integration.name}
            onToggle={() => setOpen(open === integration.name ? '' : integration.name)}
          />
        ))}
      </ul>

      <style jsx>{`
        .ix__list {
          list-style: none;
          border-top: 1px solid var(--line);
        }
      `}</style>
    </div>
  );
}

function IntegrationRow({
  integration,
  open,
  onToggle,
}: {
  integration: Integration;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <li className={`row ${open ? 'row--open' : ''}`}>
      <button type="button" className="row__head" onClick={onToggle} aria-expanded={open}>
        <span className="row__name">{integration.name}</span>
        <span className="row__role">{integration.role}</span>
        <span className={`row__status row__status--${integration.status}`}>
          <span className="row__dot" aria-hidden="true" />
          {STATUS_COPY[integration.status]}
        </span>
        <span className="row__chev" aria-hidden="true">
          {open ? '−' : '+'}
        </span>
      </button>

      {open ? (
        <div className="row__body">
          <p className="row__detail">{integration.detail}</p>
          <p className="row__note">{integration.statusNote}</p>
          <div className="row__meta">
            <span className="ap-mono row__where">{integration.where}</span>
            {integration.links.map((link) => (
              <a key={link.href} href={link.href} target="_blank" rel="noreferrer noopener" className="row__link">
                {link.label} ↗
              </a>
            ))}
          </div>
        </div>
      ) : null}

      <style jsx>{`
        .row {
          border-bottom: 1px solid var(--line);
        }
        .row--open {
          background: var(--bg-2);
        }
        .row__head {
          width: 100%;
          display: grid;
          grid-template-columns: minmax(150px, 210px) 1fr auto 28px;
          align-items: center;
          gap: 20px;
          padding: 18px 18px 18px 4px;
          background: none;
          border: 0;
          font: inherit;
          color: inherit;
          text-align: left;
          cursor: pointer;
          transition: background var(--dur-1) var(--ease-out);
        }
        .row__head:hover {
          background: var(--bg-3);
        }
        @media (max-width: 760px) {
          .row__head {
            grid-template-columns: 1fr auto;
            gap: 6px 14px;
          }
          .row__role {
            grid-column: 1 / -1;
          }
        }
        .row__name {
          font-family: var(--font-display);
          font-size: var(--text-h2);
          font-weight: 700;
          letter-spacing: var(--tracking-tight);
        }
        .row__role {
          font-size: var(--text-small);
          color: var(--ink-3);
        }
        .row__status {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          font-size: var(--text-caption);
          font-family: var(--font-mono);
          letter-spacing: var(--tracking-wide);
          text-transform: uppercase;
          color: var(--teal-ink);
          white-space: nowrap;
        }
        .row__status--partial {
          color: var(--amber);
        }
        .row__dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: currentColor;
        }
        .row__chev {
          font-family: var(--font-mono);
          font-size: 18px;
          color: var(--ink-4);
          text-align: center;
        }
        .row__body {
          padding: 0 18px 24px 4px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          max-width: 78ch;
          animation: rowin var(--dur-2) var(--ease-out);
        }
        .row__detail {
          font-size: var(--text-h3);
          line-height: var(--leading-body);
          color: var(--ink);
        }
        .row__note {
          font-size: var(--text-small);
          line-height: var(--leading-body);
          color: var(--ink-3);
          border-left: 2px solid var(--line-2);
          padding-left: 13px;
        }
        .row__meta {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          align-items: center;
          margin-top: 2px;
        }
        .row__where {
          font-size: var(--text-caption);
          color: var(--ink-3);
          background: var(--bg-3);
          padding: 4px 9px;
          border-radius: var(--radius-sm);
        }
        .row__link {
          font-size: var(--text-caption);
          font-weight: 600;
          color: var(--teal-ink);
          text-decoration: none;
          border: 1px solid var(--teal-line);
          padding: 4px 10px;
          border-radius: var(--radius-pill);
          transition: background var(--dur-1) var(--ease-out);
        }
        .row__link:hover {
          background: var(--teal-bg);
        }
        @keyframes rowin {
          from {
            opacity: 0;
            transform: translateY(-4px);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .row__body {
            animation: none;
          }
        }
      `}</style>
    </li>
  );
}
