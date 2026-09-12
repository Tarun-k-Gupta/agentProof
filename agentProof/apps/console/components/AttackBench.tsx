'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address, Hex } from '@agentproof/sdk';
// Pure calldata encoders only — the SDK barrel pulls node-only modules that
// cannot bundle for the browser. Single source: packages/sdk/src/testing/calldata.ts.
import {
  encodeErc20Approve,
  encodeErc20Transfer,
  encodeSwapExactIn,
  encodeSwapExactOut,
  UNLIMITED_APPROVAL,
} from '@agentproof/sdk/calldata';
import { api } from '@/lib/api';
import type { ApprovalRequest, Health, Verdict } from '@/lib/types';
import { Amount, DecisionChip, PolicyRow, ProofSeal, short } from '../../shared-design/ui';

const WETH_SEPOLIA = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14' as Address;
const ATTACKER = '0x000000000000000000000000000000000000dead' as Address;

type Template = 'swap-in' | 'swap-out' | 'transfer' | 'approve' | 'unlimited-approve';

/**
 * Named attacks, not just form fields.
 *
 * The old playground gave you a template dropdown and left you to work out what
 * was interesting about each one. Every preset here states the attack it is and
 * what the system is supposed to do about it, so a wrong answer is legible as a
 * wrong answer rather than as an unexplained verdict.
 */
const PRESETS: Array<{
  id: string;
  name: string;
  story: string;
  expect: string;
  template: Template;
  amount: string;
  recipient?: string;
}> = [
  {
    id: 'ordinary',
    name: 'A normal trade',
    story: 'The AI swaps 80 USDC. Nothing unusual about it.',
    expect: 'Should go through',
    template: 'swap-in',
    amount: '80',
  },
  {
    id: 'oversized',
    name: 'The AI bets too big',
    story: 'A price drop convinces it to risk 250 USDC in one go. The reasoning sounds fine. The size is not.',
    expect: 'Should be stopped — over your limit',
    template: 'swap-in',
    amount: '250',
  },
  {
    id: 'approval',
    name: 'The AI asks permission',
    story: 'A 100 USDC trade — big enough that you said you wanted to be asked first.',
    expect: 'Should pause and wait for you',
    template: 'swap-in',
    amount: '100',
  },
  {
    id: 'exact-out',
    name: 'The hidden price tag',
    story:
      'A swap that advertises a tiny amount but authorises a huge one. Read the wrong number and it looks cheap.',
    expect: 'Should be priced on what it can actually spend',
    template: 'swap-out',
    amount: '250',
  },
  {
    id: 'injection',
    name: 'The AI gets tricked',
    story: 'A web page tells the AI to send the money to a stranger. It believes it.',
    expect: 'Should be stopped — unknown recipient',
    template: 'transfer',
    amount: '50',
    recipient: ATTACKER,
  },
  {
    id: 'unlimited',
    name: 'A blank cheque',
    story: 'One approval that lets a contract take every token the wallet will ever hold.',
    expect: 'Should be stopped — always',
    template: 'unlimited-approve',
    amount: '0',
  },
];

const FALLBACK = {
  asset: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
  router: '0x3a9d48ab9751398bbfa63ad67599bb04e4bdf98b',
  account: '0x00000000000000000000000000000000000000a1',
  agent: 'trader.agentproof.eth',
};

function toBaseUnits(amountUsdc: string): bigint {
  const [whole = '0', frac = ''] = amountUsdc.split('.');
  return BigInt(whole || '0') * 1_000_000n + BigInt((frac + '000000').slice(0, 6) || '0');
}

export function AttackBench() {
  const [health, setHealth] = useState<Health>();
  const [addrs, setAddrs] = useState(FALLBACK);
  const [template, setTemplate] = useState<Template>('swap-in');
  const [amount, setAmount] = useState('250');
  const [recipient, setRecipient] = useState<string>(ATTACKER);
  const [verdict, setVerdict] = useState<Verdict>();
  /**
   * The escalation currently in flight.
   *
   * `/v1/verify` holds the connection open while a human decides, so this is
   * genuinely a paused transaction rather than a notification about one — the
   * fetch below has not returned yet while this is set.
   */
  const [pending, setPending] = useState<ApprovalRequest>();
  const [secondsLeft, setSecondsLeft] = useState(0);
  /**
   * True only while a verify of ours is in flight.
   *
   * The stream replays its last 50 events to every new subscriber, so a fresh
   * page load receives approval frames from requests that were settled long
   * ago. Rendering those would put a live-looking Approve/Decline card on
   * screen for a decision nobody is waiting on. An approval is ours only if we
   * are still waiting for a verdict.
   */
  const awaiting = useRef(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [ran, setRan] = useState<string>();

  useEffect(() => {
    void (async () => {
      const result = await api.health();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setHealth(result.value);
      setAddrs((previous) => ({ ...previous, account: result.value.account, agent: result.value.agent }));
      const policy = await api.policy(result.value.agent);
      if (policy.ok) {
        const doc = (policy.value.policy as any)?.document ?? policy.value.policy;
        if (doc?.asset?.address) {
          setAddrs((previous) => ({
            ...previous,
            asset: doc.asset.address,
            router: doc.policies?.allowedContracts?.[0] ?? previous.router,
            // Swap output goes to an address the policy allowlists. The
            // protected account is not itself on that list, and sending there
            // makes every scenario fail for the same uninteresting reason.
            account: doc.policies?.allowedRecipients?.[0] ?? previous.account,
          }));
        }
      }
    })();
  }, []);

  useEffect(() => {
    const source = new EventSource('/api/v1/stream');
    source.addEventListener('approval', (event) => {
      try {
        const request = JSON.parse((event as MessageEvent<string>).data) as ApprovalRequest;
        if (!awaiting.current) return;
        if (request.expiresAt && request.expiresAt <= Date.now()) return;
        setPending(request);
      } catch {
        /* a malformed frame is not worth tearing the stream down for */
      }
    });
    return () => source.close();
  }, []);

  // Count down to the same deadline the API will enforce, so the number on
  // screen is the real one rather than a decorative timer.
  useEffect(() => {
    if (!pending?.expiresAt) return;
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((pending.expiresAt! - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [pending?.expiresAt]);

  const answer = useCallback(
    async (approved: boolean) => {
      if (!pending) return;
      await api.approve(pending.id, approved);
      setPending(undefined);
    },
    [pending],
  );

  const buildAction = useCallback(
    (kind: Template, amountUsdc: string, to: string): { to: string; data: Hex } => {
      const amountIn = toBaseUnits(amountUsdc);
      if (kind === 'swap-in') {
        return {
          to: addrs.router,
          data: encodeSwapExactIn({
            recipient: addrs.account as Address,
            amountIn,
            tokenIn: addrs.asset as Address,
            tokenOut: WETH_SEPOLIA,
          }),
        };
      }
      if (kind === 'swap-out') {
        return {
          to: addrs.router,
          data: encodeSwapExactOut({
            recipient: addrs.account as Address,
            amountOut: 1n,
            amountInMaximum: amountIn,
            tokenIn: addrs.asset as Address,
            tokenOut: WETH_SEPOLIA,
          }),
        };
      }
      if (kind === 'transfer') return { to: addrs.asset, data: encodeErc20Transfer(to as Address, amountIn) };
      if (kind === 'approve') return { to: addrs.asset, data: encodeErc20Approve(to as Address, amountIn) };
      return { to: addrs.asset, data: encodeErc20Approve(addrs.router as Address, UNLIMITED_APPROVAL) };
    },
    [addrs],
  );

  const evaluate = useCallback(
    async (kind: Template, amountUsdc: string, to: string, label?: string) => {
      setBusy(true);
      setError(undefined);
      awaiting.current = true;
      try {
        const action = buildAction(kind, amountUsdc, to);
        const response = await fetch('/api/v1/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          // An escalated action holds this connection open until a human
          // answers. The API's own deadline is the one that decides, so the
          // client must outlast it rather than abort a live approval.
          signal: AbortSignal.timeout(180_000),
          body: JSON.stringify({
            agent: addrs.agent,
            action: { ...action, value: '0', chainId: health?.mode === 'production' ? 11155111 : 11155111 },
          }),
        });
        const parsed = await response.json();
        if (!response.ok) throw new Error(parsed?.error ?? `${response.status}`);
        setVerdict(parsed as Verdict);
        setPending(undefined);
        setRan(label);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        awaiting.current = false;
        setBusy(false);
        setPending(undefined);
      }
    },
    [addrs.agent, buildAction, health?.mode],
  );

  return (
    <div className="bench">
      <section className="bench__presets">
        <h2 className="bench__h">Pick something to try</h2>
        <div className="bench__preset-grid">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`preset ${ran === preset.name ? 'preset--ran' : ''}`}
              disabled={busy}
              onClick={() => {
                setTemplate(preset.template);
                setAmount(preset.amount);
                if (preset.recipient) setRecipient(preset.recipient);
                void evaluate(preset.template, preset.amount, preset.recipient ?? addrs.account, preset.name);
              }}
            >
              <span className="preset__name">{preset.name}</span>
              <span className="preset__story">{preset.story}</span>
              <span className="preset__expect">{preset.expect}</span>
            </button>
          ))}
        </div>

        <details className="bench__free">
          <summary>Or make up your own</summary>
          <div className="bench__form">
            <label className="ap-field">
              What the AI tries to do
              <select className="ap-select" value={template} onChange={(e) => setTemplate(e.target.value as Template)}>
                <option value="swap-in">Swap — spend this much</option>
                <option value="swap-out">Swap — spend up to this much</option>
                <option value="transfer">Send tokens to someone</option>
                <option value="approve">Let someone spend this much</option>
                <option value="unlimited-approve">Let someone spend everything</option>
              </select>
            </label>
            <label className="ap-field">
              Amount in USDC
              <input className="ap-input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
            </label>
            <label className="ap-field">
              Who receives it
              <input className="ap-input ap-mono" value={recipient} onChange={(e) => setRecipient(e.target.value)} />
            </label>
            <button
              type="button"
              className="ap-btn"
              disabled={busy}
              onClick={() => void evaluate(template, amount, recipient, 'custom')}
            >
              {busy ? 'Evaluating…' : 'Evaluate'}
            </button>
          </div>
        </details>
      </section>

      <section className="bench__verdict">
        <h2 className="bench__h">What happened</h2>
        {pending ? (
          <div className="paused">
            <span className="paused__eyebrow">Paused — the agent is waiting for you</span>
            <p className="paused__what">{pending.intent?.summary ?? pending.reason}</p>
            <p className="paused__why">{pending.reason}</p>
            <div className="paused__timer">
              <span className="paused__count">{secondsLeft}s</span>
              <span className="paused__note">
                If you do nothing, it is refused. Silence is not consent.
              </span>
            </div>
            <div className="paused__btns">
              <button type="button" className="ap-btn" onClick={() => void answer(true)}>
                Approve
              </button>
              <button type="button" className="ap-btn ap-btn--ghost" onClick={() => void answer(false)}>
                Decline
              </button>
            </div>
          </div>
        ) : error ? (
          <p className="bench__error">{error}</p>
        ) : !verdict ? (
          <p className="ap-dim">
            Pick one on the left. Nothing here is pre-recorded — each result is worked out when you press it.
          </p>
        ) : (
          <div className={`ap-verdict ap-verdict--${verdict.decision}`}>
            <div className="bench__verdict-head">
              <span className="ap-verdict__decision">{verdict.decision}</span>
              <DecisionChip decision={verdict.decision} />
              {verdict.proof ? <ProofSeal property={verdict.proof.property} status={verdict.proof.status} /> : null}
            </div>
            {verdict.reason ? <p className="ap-verdict__reason">{verdict.reason}</p> : null}
            {verdict.approval ? (
              <p className="bench__settled">
                {verdict.approval.by.endsWith(':timeout')
                  ? 'Nobody answered in time, so it was refused.'
                  : verdict.approval.approved
                    ? 'You approved this. Only then did it go through.'
                    : 'You declined this. It never happened.'}
              </p>
            ) : null}
            {verdict.intent ? <p className="ap-dim">{verdict.intent.summary}</p> : null}

            {verdict.intent?.outflow?.length ? (
              <div className="bench__outflow">
                <span className="bench__label">Money leaving the wallet</span>
                <div>
                  {verdict.intent.outflow.map((flow, index) => (
                    <span key={index} className="ap-chip" title={flow.asset}>
                      {short(flow.asset)} · <Amount baseUnits={flow.amount} /> · {flow.provenance}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            {verdict.policyRows?.length ? (
              <div className="bench__rows">
                <span className="bench__label">Which of your rules it checked</span>
                {verdict.policyRows.map((row, index) => (
                  <PolicyRow
                    key={index}
                    name={row.name ?? row.id}
                    passed={row.passed !== false}
                    observed={row.observed?.toString()}
                    limit={row.limit?.toString()}
                  />
                ))}
              </div>
            ) : null}

            {verdict.settlement?.transactionId ? (
              <p className="bench__paid">
                This check was paid for. Settled on Hedera as{' '}
                <a
                  href={`https://hashscan.io/testnet/transaction/${verdict.settlement.transactionId}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="ap-mono"
                >
                  {verdict.settlement.transactionId} ↗
                </a>
              </p>
            ) : null}
            {verdict.enforcement ? (
              <p className="ap-dim bench__advisory">
                This page only gives advice. The real limit lives on-chain at{' '}
                <span className="ap-mono">{short(verdict.enforcement.hook)}</span>, which rejects the same
                transaction whether or not anyone asked us first.
              </p>
            ) : null}
          </div>
        )}
      </section>

      <style jsx>{`
        .bench {
          display: grid;
          grid-template-columns: minmax(340px, 1fr) minmax(420px, 1.1fr);
          gap: 32px;
          align-items: start;
        }
        @media (max-width: 1100px) {
          .bench {
            grid-template-columns: 1fr;
          }
        }
        .bench__h {
          font-family: var(--font-display);
          font-size: var(--text-h2);
          font-weight: 700;
          letter-spacing: var(--tracking-tight);
          margin-bottom: 14px;
        }
        .bench__preset-grid {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .preset {
          text-align: left;
          display: flex;
          flex-direction: column;
          gap: 5px;
          padding: 14px 16px;
          border: 1px solid var(--line-2);
          border-radius: var(--radius-sm);
          background: var(--card);
          font: inherit;
          color: inherit;
          cursor: pointer;
          transition: border-color var(--dur-1) var(--ease-out), box-shadow var(--dur-1) var(--ease-out);
        }
        .preset:hover:not(:disabled) {
          border-color: var(--teal);
          box-shadow: var(--shadow-1);
        }
        .preset--ran {
          border-color: var(--gold);
          box-shadow: 0 0 0 3px var(--gold-bg);
        }
        .preset:disabled {
          opacity: 0.6;
          cursor: progress;
        }
        .preset__name {
          font-family: var(--font-display);
          font-weight: 700;
          font-size: var(--text-h3);
        }
        .preset__story {
          font-size: var(--text-small);
          color: var(--ink-2);
          line-height: var(--leading-body);
        }
        .preset__expect {
          font-family: var(--font-mono);
          font-size: var(--text-caption);
          color: var(--teal-ink);
        }
        .bench__free {
          margin-top: 18px;
          border-top: 1px solid var(--line);
          padding-top: 14px;
          font-size: var(--text-small);
        }
        .bench__free summary {
          cursor: pointer;
          color: var(--ink-3);
        }
        .bench__form {
          display: grid;
          gap: 12px;
          margin-top: 14px;
        }
        .bench__verdict-head {
          display: flex;
          gap: 12px;
          align-items: center;
          flex-wrap: wrap;
        }
        .bench__label {
          display: block;
          font-family: var(--font-mono);
          font-size: var(--text-caption);
          letter-spacing: var(--tracking-wide);
          text-transform: uppercase;
          color: var(--ink-4);
          margin-bottom: 8px;
        }
        .bench__outflow,
        .bench__rows {
          margin-top: 16px;
        }
        .bench__outflow div {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .bench__advisory {
          margin-top: 16px;
          border-top: 1px solid var(--line);
          padding-top: 12px;
          font-size: var(--text-small);
          line-height: var(--leading-body);
        }
        .paused {
          border: 1px solid var(--amber-line);
          background: var(--amber-bg);
          border-radius: var(--radius);
          padding: 20px 22px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          animation: pausein var(--dur-2) var(--ease-out);
        }
        .paused__eyebrow {
          font-family: var(--font-mono);
          font-size: var(--text-caption);
          letter-spacing: var(--tracking-wide);
          text-transform: uppercase;
          color: var(--amber);
        }
        .paused__what {
          font-family: var(--font-display);
          font-size: var(--text-h2);
          font-weight: 700;
          letter-spacing: var(--tracking-tight);
          line-height: 1.2;
        }
        .paused__why {
          font-size: var(--text-small);
          color: var(--ink-2);
        }
        .paused__timer {
          display: flex;
          align-items: baseline;
          gap: 12px;
          flex-wrap: wrap;
          padding-top: 4px;
        }
        .paused__count {
          font-family: var(--font-mono);
          font-variant-numeric: tabular-nums;
          font-size: 30px;
          font-weight: 600;
          color: var(--amber);
          line-height: 1;
        }
        .paused__note {
          font-size: var(--text-small);
          color: var(--ink-3);
        }
        .paused__btns {
          display: flex;
          gap: 10px;
          margin-top: 6px;
        }
        .bench__settled {
          margin-top: 12px;
          font-size: var(--text-small);
          font-weight: 600;
          color: var(--ink);
        }
        @keyframes pausein {
          from { opacity: 0; transform: translateY(6px); }
        }
        @media (prefers-reduced-motion: reduce) {
          .paused { animation: none; }
        }
        .bench__paid {
          margin-top: 12px;
          font-size: var(--text-small);
          color: var(--ink-2);
          border-left: 2px solid var(--teal-line);
          padding-left: 12px;
          overflow-wrap: anywhere;
        }
        .bench__error {
          color: var(--red);
          font-size: var(--text-small);
        }
      `}</style>
    </div>
  );
}
