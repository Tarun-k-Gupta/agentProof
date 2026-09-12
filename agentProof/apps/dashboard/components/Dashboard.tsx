'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useStream } from '@/lib/useStream';
import type { Health, Spend, Verdict } from '@/lib/types';
import { relativeTime, SEPOLIA_EXPLORER, shortAddress, shortHash } from '@/lib/format';
import { DecisionChip, Empty, Field, Panel, ProofBadge } from './primitives';
import { PolicyRows } from './PolicyRows';
import { IntentCard } from './IntentCard';
import { SpendGauge } from './SpendGauge';
import { ProofDrawer } from './ProofDrawer';
import { PolicySettings } from './PolicySettings';
import { Approvals } from './Approvals';
import { LoginGate } from './LoginGate';

const POLL_MS = 10_000;

export function Dashboard() {
  const [health, setHealth] = useState<Health>();
  const [healthError, setHealthError] = useState<string>();
  const [spend, setSpend] = useState<Spend>();
  const [spendError, setSpendError] = useState<string>();
  const [proofOpen, setProofOpen] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [selected, setSelected] = useState<Verdict>();

  const authed = health ? !health.dashboardAuth || health.dashboardSession : false;
  const stream = useStream(authed);

  const refreshHealth = useCallback(async () => {
    const result = await api.health();
    if (result.ok) {
      setHealth(result.value);
      setHealthError(undefined);
    } else {
      setHealthError(result.error);
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
      if (result.ok) {
        setSpend(result.value);
        setSpendError(undefined);
      } else {
        setSpendError(result.error);
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [health?.account, stream.decisions.length]);

  // The newest decision is shown by default; clicking an older one pins it.
  const current = selected ?? stream.decisions[0];

  if (healthError) {
    return <Disconnected error={healthError} onRetry={() => void refreshHealth()} />;
  }
  if (!health) {
    return <Booting />;
  }
  if (health.dashboardAuth && !health.dashboardSession) {
    return <LoginGate onSuccess={() => void refreshHealth()} />;
  }

  return (
    <div className="shell">
      <Header
        health={health}
        connection={stream.connection}
        onOpenProofs={() => setProofOpen(true)}
        onOpenPolicy={() => setPolicyOpen(true)}
      />

      <main>
        <div className="pane pane-left">
          <Panel
            title="Agent reasoning"
            subtitle="Non-deterministic. Trusted to choose, not to enforce."
            live
          >
            {stream.thoughts.length === 0 ? (
              <Empty>Waiting for the agent to propose something.</Empty>
            ) : (
              <ol className="thoughts">
                {stream.thoughts.map((thought, index) => (
                  <li key={`${thought.at}-${index}`}>
                    <time dateTime={new Date(thought.at).toISOString()}>{relativeTime(thought.at)}</time>
                    <p>{thought.text}</p>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>

        <div className="pane pane-right">
          <Panel
            title="AgentProof enforcement"
            subtitle="Deterministic. The same engine the SDK runs."
            action={
              stream.decisions.length > 1 ? (
                <History
                  decisions={stream.decisions}
                  selected={current}
                  onSelect={(verdict) => setSelected(verdict)}
                />
              ) : null
            }
            live
          >
            <Approvals approvals={stream.approvals} onResolved={stream.markResolved} />

            {current ? (
              <Verdicted verdict={current} />
            ) : (
              <Empty>No decisions yet. Run the trader agent, or `pnpm demo`.</Empty>
            )}
          </Panel>
        </div>
      </main>

      <footer>
        <SpendGauge spend={spend} error={spendError} />
      </footer>

      <ProofDrawer open={proofOpen} onClose={() => setProofOpen(false)} />
      <PolicySettings
        open={policyOpen}
        onClose={() => {
          setPolicyOpen(false);
          // A saved edit changes the policy hash and, sometimes, the daily
          // limit the gauge is drawn against — both live in health/spend.
          void refreshHealth();
        }}
        agent={health.agent}
      />

      <style jsx>{`
        .shell {
          display: grid;
          grid-template-rows: var(--header-h) 1fr var(--footer-h);
          height: 100dvh;
          overflow: hidden;
        }
        main {
          display: grid;
          grid-template-columns: 1fr 1.25fr;
          min-height: 0;
        }
        .pane { min-height: 0; min-width: 0; }
        .pane-left { background: var(--bg-2); border-right: 1px solid var(--line); }
        footer { border-top: 1px solid var(--line); background: var(--bg); }
        .thoughts { display: flex; flex-direction: column; gap: 12px; }
        .thoughts li {
          padding-left: 14px;
          border-left: 2px solid var(--line-2);
        }
        .thoughts li:first-child { border-left-color: var(--teal); }
        .thoughts time { font-size: 11px; color: var(--ink-4); }
        .thoughts p { font-size: 13.5px; line-height: 1.6; color: var(--ink-2); margin-top: 2px; white-space: pre-wrap; }
        @media (max-width: 900px) {
          .shell { grid-template-rows: var(--header-h) 1fr 1fr var(--footer-h); height: auto; min-height: 100dvh; }
          main { grid-template-columns: 1fr; }
          .pane-left { border-right: none; border-bottom: 1px solid var(--line); }
        }
      `}</style>
    </div>
  );
}

function Verdicted({ verdict }: { verdict: Verdict }) {
  return (
    <div className="verdict">
      <div className="verdict-head">
        <DecisionChip decision={verdict.decision} />
        {verdict.proof ? (
          <ProofBadge
            status={verdict.proof.status}
            detail={`${verdict.proof.property} · ${verdict.proof.tool} · ${verdict.proof.solverTimeMs} ms`}
          />
        ) : null}
      </div>

      {verdict.reason ? <p className="reason">{verdict.reason}</p> : null}

      <IntentCard intent={verdict.intent} />

      <section>
        <h3>Policies</h3>
        <PolicyRows verdict={verdict} />
      </section>

      {verdict.txHash ? (
        <Field label="Transaction" mono>
          <a href={`${SEPOLIA_EXPLORER}/tx/${verdict.txHash}`} target="_blank" rel="noreferrer noopener">
            {shortHash(verdict.txHash)}
          </a>
        </Field>
      ) : null}

      {/*
        Restated on every decision, because the most dangerous misreading of this
        page is that it is the thing doing the stopping.
      */}
      <p className="advisory">
        Advisory. Enforcement is the ERC-7579 hook at {shortAddress(verdict.enforcement.hook)} on{' '}
        {shortAddress(verdict.enforcement.account)} — running in <strong>{verdict.enforcement.mode}</strong> mode.
      </p>

      <style jsx>{`
        .verdict { display: flex; flex-direction: column; gap: 18px; }
        .verdict-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .reason {
          font-size: 13.5px;
          line-height: 1.55;
          color: var(--ink-2);
          padding: 10px 12px;
          background: var(--bg-2);
          border-left: 2px solid var(--line-2);
          border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
        }
        h3 {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--ink-4);
          margin-bottom: 6px;
        }
        .advisory {
          font-size: 11.5px;
          color: var(--ink-4);
          border-top: 1px solid var(--line);
          padding-top: 12px;
        }
      `}</style>
    </div>
  );
}

function History({
  decisions,
  selected,
  onSelect,
}: {
  decisions: Verdict[];
  selected?: Verdict;
  onSelect: (verdict: Verdict) => void;
}) {
  return (
    <div className="history" role="group" aria-label="Recent decisions">
      {decisions.slice(0, 8).map((verdict, index) => {
        const active = verdict === selected;
        const tone = verdict.decision === 'ALLOW' ? 'allow' : verdict.decision === 'BLOCK' ? 'block' : 'approval';
        return (
          <button
            key={index}
            type="button"
            className={`dot dot-${tone} ${active ? 'is-active' : ''}`}
            onClick={() => onSelect(verdict)}
            aria-pressed={active}
            aria-label={`${verdict.decision}: ${verdict.intent.summary}`}
            title={verdict.intent.summary}
          />
        );
      })}
      <style jsx>{`
        .history { display: flex; gap: 5px; align-items: center; }
        .dot {
          width: 11px;
          height: 11px;
          padding: 0;
          border-radius: 50%;
          border: 1px solid transparent;
          cursor: pointer;
          opacity: 0.4;
          transition: opacity 120ms ease, transform 120ms ease;
        }
        /* The dots are small, so the hit area is padded out to a usable size. */
        .dot::after { content: ''; position: absolute; inset: -12px; }
        .dot { position: relative; }
        .dot:hover, .dot.is-active { opacity: 1; transform: scale(1.15); }
        .dot-allow { background: var(--teal); }
        .dot-block { background: var(--red); }
        .dot-approval { background: var(--amber); }
      `}</style>
    </div>
  );
}

function Header({
  health,
  connection,
  onOpenProofs,
  onOpenPolicy,
}: {
  health: Health;
  connection: string;
  onOpenProofs: () => void;
  onOpenPolicy: () => void;
}) {
  const proven = health.proofs.filter((p) => p.status === 'PROVEN').length;

  return (
    <header className="bar">
      <div className="brand">
        <span className="mark" aria-hidden="true" />
        <div>
          <strong>AgentProof</strong>
          <span className="claim">Trust the agent to decide. Don’t trust it to enforce its own limits.</span>
        </div>
      </div>

      <div className="meta">
        <span className="agent mono" title={`policy ${health.policyHash}`}>
          {health.agent}
        </span>
        <span className={`mode mode-${health.mode}`}>{health.mode}</span>
        <button type="button" className="proofs" onClick={onOpenProofs}>
          Proofs {proven}/{health.proofs.length}
        </button>
        <button type="button" className="proofs" onClick={onOpenPolicy}>
          Policy
        </button>
        <span className={`conn conn-${connection}`} title={`event stream: ${connection}`}>
          <span className="conn-dot" aria-hidden="true" />
          <span className="sr-only">Event stream {connection}</span>
        </span>
      </div>

      <style jsx>{`
        .bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 0 20px;
          border-bottom: 1px solid var(--line);
          background: var(--bg);
        }
        .brand { display: flex; align-items: center; gap: 11px; min-width: 0; }
        .mark {
          width: 10px;
          height: 10px;
          border-radius: 3px;
          background: var(--teal);
          box-shadow: 0 0 0 3px var(--teal-bg);
          flex: 0 0 auto;
        }
        .brand strong { font-size: 14px; font-weight: 700; letter-spacing: -0.01em; display: block; }
        .claim { font-size: 11.5px; color: var(--ink-4); display: block; margin-top: -2px; }
        .meta { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; }
        .agent { font-size: 12px; color: var(--ink-2); }
        .mode {
          font-size: 10.5px;
          font-weight: 700;
          letter-spacing: 0.05em;
          text-transform: uppercase;
          padding: 2px 7px;
          border-radius: 5px;
          border: 1px solid var(--line);
          color: var(--ink-3);
          background: var(--bg-2);
        }
        .mode-production { color: var(--teal-ink); border-color: var(--teal-line); background: var(--teal-bg); }
        .proofs {
          min-height: 32px;
          padding: 0 12px;
          border-radius: var(--radius-sm);
          border: 1px solid var(--line);
          background: var(--bg-2);
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
        }
        .proofs:hover { background: var(--bg-3); }
        .conn { display: inline-flex; padding: 6px; }
        .conn-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-4); }
        .conn-open .conn-dot { background: var(--teal); }
        .conn-connecting .conn-dot { background: var(--amber); }
        .conn-unauthorized .conn-dot, .conn-closed .conn-dot { background: var(--red); }
        @media (max-width: 720px) {
          .claim, .agent { display: none; }
        }
      `}</style>
    </header>
  );
}

function Booting() {
  return (
    <Centered>
      <p>Connecting to the Verification API…</p>
    </Centered>
  );
}

function Disconnected({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <Centered>
      <h1>The Verification API is not reachable</h1>
      <p className="why">{error}</p>
      <p className="hint">
        Start it with <code>pnpm api</code>, or point <code>AGENTPROOF_API_URL</code> at a running instance.
      </p>
      <button type="button" onClick={onRetry}>
        Retry
      </button>
      <p className="note">
        Nothing is being hidden from you here — the dashboard has no cached decisions to show, and inventing one would
        be worse than this page.
      </p>
      <style jsx>{`
        h1 { font-size: 17px; font-weight: 650; }
        .why { color: var(--red); font-size: 13px; margin-top: 6px; }
        .hint { color: var(--ink-3); font-size: 13px; margin-top: 10px; }
        button {
          min-height: 44px;
          margin-top: 16px;
          padding: 0 20px;
          border-radius: var(--radius-sm);
          border: 1px solid var(--teal);
          background: var(--teal);
          color: #fff;
          font-weight: 600;
          cursor: pointer;
        }
        .note { color: var(--ink-4); font-size: 12px; margin-top: 20px; max-width: 44ch; }
        code { font-family: var(--mono); background: var(--bg-3); padding: 1px 5px; border-radius: 4px; }
      `}</style>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="wrap">
      <div className="inner">{children}</div>
      <style jsx>{`
        .wrap { display: grid; place-items: center; height: 100dvh; padding: 24px; }
        .inner { max-width: 420px; text-align: center; color: var(--ink-2); }
      `}</style>
    </div>
  );
}
