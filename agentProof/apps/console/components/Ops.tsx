'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useStream } from '@/lib/useStream';
import type { Health, Spend, Verdict } from '@/lib/types';
import { relativeTime, shortAddress } from '@/lib/format';
import { DecisionChip, Empty } from './primitives';
import { PolicyRows } from './PolicyRows';
import { IntentCard } from './IntentCard';
import { SpendGauge } from './SpendGauge';
import { Approvals } from './Approvals';
import { LoginGate } from './LoginGate';
import { PolicySettings } from './PolicySettings';

const POLL_MS = 10_000;

/**
 * The operator surface.
 *
 * Three columns, because an operator has three standing questions and should
 * never have to navigate between them: what is the agent doing right now, what
 * is waiting on me, and how much of the budget is left.
 */
export function Ops() {
  const [health, setHealth] = useState<Health>();
  const [error, setError] = useState<string>();
  const [spend, setSpend] = useState<Spend>();
  const [selected, setSelected] = useState<Verdict>();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const authed = health ? !health.dashboardAuth || health.dashboardSession : false;
  const stream = useStream(authed);

  const refreshHealth = useCallback(async () => {
    const result = await api.health();
    if (result.ok) {
      setHealth(result.value);
      setError(undefined);
    } else {
      setError(result.error);
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
    const timer = setInterval(() => void refreshHealth(), POLL_MS);
    return () => clearInterval(timer);
  }, [refreshHealth]);

  useEffect(() => {
    if (!health?.account) return;
    const load = async () => {
      const result = await api.spend(health.account);
      if (result.ok) setSpend(result.value);
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [health?.account, stream.decisions.length]);

  if (error) {
    return (
      <p className="ap-dim" style={{ maxWidth: '60ch', lineHeight: 'var(--leading-body)' }}>
        The Verification API is not reachable: {error}. Start it with <span className="ap-mono">pnpm api</span>. The
        architecture map and evidence pages work without it.
      </p>
    );
  }
  if (!health) return <p className="ap-dim">Connecting…</p>;
  if (health.dashboardAuth && !health.dashboardSession) {
    return <LoginGate onSuccess={() => void refreshHealth()} />;
  }

  const current = selected ?? stream.decisions[0];

  return (
    <div className="ops">
      <section className="ops__col">
        <h2 className="ops__h">
          Live decisions
          <span className={`dot dot--${stream.connection}`} aria-hidden="true" />
        </h2>
        {stream.decisions.length === 0 ? (
          <Empty>
            Nothing yet. Open <a href="/run">Try it yourself</a> and press a scenario — every decision the agent makes
            appears here the moment it happens.
          </Empty>
        ) : (
          <ol className="ops__feed">
            {stream.decisions.map((decision, index) => (
              <li key={index}>
                <button
                  type="button"
                  className={`ops__item ${current === decision ? 'ops__item--on' : ''}`}
                  onClick={() => setSelected(decision)}
                >
                  <DecisionChip decision={decision.decision} />
                  <span className="ops__item-text">{decision.intent?.summary ?? decision.reason ?? '—'}</span>
                </button>
              </li>
            ))}
          </ol>
        )}

        {stream.thoughts.length > 0 ? (
          <>
            <h2 className="ops__h">Agent reasoning</h2>
            <ol className="ops__thoughts">
              {stream.thoughts.slice(0, 8).map((thought, index) => (
                <li key={index}>
                  <span className="ap-dim ap-mono">{relativeTime(thought.at)}</span> {thought.text}
                </li>
              ))}
            </ol>
          </>
        ) : null}
      </section>

      <section className="ops__col">
        <h2 className="ops__h">The current verdict</h2>
        {current ? (
          <div className={`ap-verdict ap-verdict--${current.decision}`}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="ap-verdict__decision">{current.decision}</span>
              <DecisionChip decision={current.decision} />
            </div>
            {current.reason ? <p className="ap-verdict__reason">{current.reason}</p> : null}
            {current.intent ? <IntentCard intent={current.intent} /> : null}
            {current.policyRows?.length ? <PolicyRows verdict={current} /> : null}
            {current.enforcement ? (
              <p className="ap-dim" style={{ fontSize: 'var(--text-small)', marginTop: 14 }}>
                Advisory. Enforcement is the hook {shortAddress(current.enforcement.hook)} on{' '}
                {shortAddress(current.enforcement.account)} ({current.enforcement.mode}).
              </p>
            ) : null}
          </div>
        ) : (
          <Empty>Select a decision, or wait for one to arrive.</Empty>
        )}
      </section>

      <section className="ops__col">
        <h2 className="ops__h">Waiting on you</h2>
        <p className="ops__note">
          Trades at or above your approval limit stop here instead of going through. Try{' '}
          <a href="/run">The AI asks permission</a>.
        </p>
        <Approvals approvals={stream.approvals} onResolved={stream.markResolved} />

        <h2 className="ops__h">Budget today</h2>
        <p className="ops__note">Spent so far against your daily cap, read back from the chain.</p>
        {spend ? <SpendGauge spend={spend} /> : <Empty>Spend appears once the API reports an account.</Empty>}

        <button type="button" className="ap-btn ap-btn--ghost" onClick={() => setSettingsOpen(true)}>
          Edit policy limits
        </button>
      </section>

      <PolicySettings open={settingsOpen} onClose={() => setSettingsOpen(false)} agent={health.agent} />

      <style jsx>{`
        .ops {
          display: grid;
          grid-template-columns: minmax(280px, 0.85fr) minmax(380px, 1.3fr) minmax(280px, 0.85fr);
          gap: 28px;
          align-items: start;
        }
        @media (max-width: 1200px) {
          .ops {
            grid-template-columns: 1fr;
          }
        }
        .ops__col {
          display: flex;
          flex-direction: column;
          gap: 12px;
          min-width: 0;
        }
        .ops__h {
          font-family: var(--font-display);
          font-size: var(--text-h2);
          font-weight: 700;
          letter-spacing: var(--tracking-tight);
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .ops__h:not(:first-child) {
          margin-top: 18px;
        }
        .ops__feed {
          display: flex;
          flex-direction: column;
          gap: 4px;
          list-style: none;
        }
        .ops__item {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 10px;
          text-align: left;
          padding: 9px 10px;
          border-radius: var(--radius-sm);
          border: 1px solid transparent;
          background: none;
          font: inherit;
          color: inherit;
          cursor: pointer;
          font-size: var(--text-small);
        }
        .ops__item:hover {
          background: var(--bg-2);
        }
        .ops__item--on {
          background: var(--bg-2);
          border-color: var(--line-2);
        }
        .ops__item-text {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ops__note {
          font-size: var(--text-small);
          color: var(--ink-3);
          line-height: var(--leading-body);
          margin-top: -4px;
        }
        .ops__thoughts {
          display: flex;
          flex-direction: column;
          gap: 8px;
          list-style: none;
          font-size: var(--text-small);
          line-height: var(--leading-body);
          color: var(--ink-2);
        }
      `}</style>
    </div>
  );
}
