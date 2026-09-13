'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { Health } from '@/lib/types';
import { ThemeToggle, short } from '../../shared-design/ui';
import { CHAIN } from '@/lib/deployments';

/**
 * The persistent frame.
 *
 * Identity and liveness live here rather than on each page, because the single
 * most common failure of the old apps was a viewer looking at a number without
 * knowing which agent it belonged to, which chain it was on, or whether the
 * feed behind it was still connected.
 */

const NAV = [
  { href: '/', n: '01', label: 'What it does', hint: 'Start here' },
  { href: '/run', n: '02', label: 'Try it yourself', hint: 'Send a bad transaction, watch it get stopped' },
  { href: '/ops', n: '03', label: 'Watch it run', hint: 'Live decisions and spending' },
  { href: '/proof', n: '04', label: 'See the receipts', hint: 'Contracts, proofs, on-chain history' },
];

const POLL_MS = 10_000;

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [health, setHealth] = useState<Health>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const load = async () => {
      const result = await api.health();
      if (result.ok) {
        setHealth(result.value);
        setError(undefined);
      } else {
        setError(result.error);
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="cs">
      <a href="#work" className="skip">
        Skip to content
      </a>
      <nav className="rail" aria-label="Console sections">
        <div className="rail__brand">
          <span className="rail__mark" aria-hidden="true" />
          <span className="rail__name">AgentProof</span>
        </div>

        <div className="rail__nav">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rail__link"
              aria-current={pathname === item.href ? 'page' : undefined}
            >
              <span className="rail__num">{item.n}</span>
              <span>
                {item.label}
                <small>{item.hint}</small>
              </span>
            </Link>
          ))}
        </div>

        <div className="rail__spacer" />

        <div className="rail__block">
          <span className="rail__label">Agent under watch</span>
          {health ? (
            <>
              <div className="rail__kv">
                <span>name</span>
                <span>{health.agent}</span>
              </div>
              <div className="rail__kv">
                <span>account</span>
                <span title={health.account}>{short(health.account)}</span>
              </div>
              <div className="rail__kv">
                <span>hook</span>
                <span title={health.hook}>{short(health.hook)}</span>
              </div>
              <div className="rail__kv">
                <span>policy</span>
                <span title={health.policyHash}>{short(health.policyHash)}</span>
              </div>
            </>
          ) : (
            <p className="ap-dim" style={{ fontSize: 'var(--text-small)' }}>
              {error ? 'API unreachable' : 'connecting…'}
            </p>
          )}
        </div>

        <div className="rail__block">
          <span className="rail__label">Status</span>
          <div className="rail__kv">
            <span>chain</span>
            <span>
              {CHAIN.name} · {CHAIN.id}
            </span>
          </div>
          <div className="rail__kv">
            <span>mode</span>
            <span>{health?.mode ?? '—'}</span>
          </div>
          <div className="rail__kv">
            <span>x402</span>
            <span>{health ? (health.x402 ? 'on' : 'off') : '—'}</span>
          </div>
          <div className="rail__kv">
            <span>API</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span className={`dot dot--${health ? 'open' : error ? 'closed' : 'connecting'}`} aria-hidden="true" />
              {health ? 'live' : error ? 'down' : '…'}
            </span>
          </div>
        </div>

        <div className="rail__block">
          <ThemeToggle />
          {error ? (
            <p className="ap-dim" style={{ fontSize: 'var(--text-caption)', lineHeight: 1.5 }}>
              {error}. Start it with <span className="ap-mono">pnpm api</span>. The architecture map still works
              offline — only live numbers are missing.
            </p>
          ) : null}
        </div>
      </nav>

      <main className="work" id="work">
        {children}
      </main>
    </div>
  );
}
