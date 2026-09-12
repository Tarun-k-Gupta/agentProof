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
import {
  AddrChip,
  Amount,
  DecisionChip,
  PolicyRow,
  ProofSeal,
  SpendRing,
  ThemeToggle,
  short,
} from '../../shared-design/ui';

const WETH_SEPOLIA = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14' as Address;
const ATTACKER = '0x000000000000000000000000000000000000dead' as Address;
const SEPOLIA_EXPLORER = 'https://sepolia.etherscan.io';

type Template = 'swap-in' | 'swap-out' | 'transfer' | 'approve' | 'unlimited-approve';

/** The two canonical price signals from apps/agents/trader/index.ts. */
const SIGNALS = [
  {
    pair: 'ETH/USDC',
    price: '3,180.42',
    change: '-1.2%',
    note: 'range-bound, low volatility',
    reasoning: 'Range-bound. A small position is proportionate.',
    amountUsdc: '80',
  },
  {
    pair: 'ETH/USDC',
    price: '2,910.10',
    change: '-8.6%',
    note: 'sharp drawdown, unusual volume',
    reasoning: 'An 8.6% drawdown on unusual volume is the strongest signal in the window. Sizing up to capture the reversion.',
    amountUsdc: '250',
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

export default function Page() {
  const [health, setHealth] = useState<any>();
  const [error, setError] = useState<string>();
  const [addrs, setAddrs] = useState(FALLBACK);
  const [policyData, setPolicyData] = useState<any>();
  const [proofsData, setProofsData] = useState<any>();
  const [template, setTemplate] = useState<Template>('swap-in');
  const [amount, setAmount] = useState('250');
  const [recipient, setRecipient] = useState<string>(ATTACKER);
  const [selected, setSelected] = useState<any>();
  const [feed, setFeed] = useState<any[]>([]);
  const [streamState, setStreamState] = useState('connecting');
  const [spend, setSpend] = useState<any>();
  const [busy, setBusy] = useState(false);
  const seenRef = useRef(new Set<string>());

  const pushFeed = useCallback((item: any) => {
    const key = `${item?.intent?.summary ?? ''}|${item?.decision ?? ''}|${item?.reason ?? ''}`;
    if (seenRef.current.has(key)) return;
    seenRef.current.add(key);
    setFeed((prev) => [item, ...prev].slice(0, 20));
  }, []);

  const load = useCallback(async () => {
    try {
      const h = await (await fetch('/api/health')).json();
      if (!h.ok) throw new Error(h.error ?? 'API not ok');
      setHealth(h);
      setError(undefined);
      const agent = h.agent ?? FALLBACK.agent;
      const [p, proofs] = await Promise.all([
        (await fetch(`/api/v1/policy/${encodeURIComponent(agent)}`)).json(),
        (await fetch('/api/v1/proofs')).json(),
      ]);
      setPolicyData(p);
      setProofsData(proofs);
      const doc = p.policy?.document ?? p.policy;
      if (doc?.asset?.address) {
        setAddrs({
          asset: doc.asset.address,
          router: doc.policies?.allowedContracts?.[0] ?? FALLBACK.router,
          account: doc.enforcement?.account ?? h.account ?? FALLBACK.account,
          agent,
        });
      } else if (h.account) {
        setAddrs((a) => ({ ...a, account: h.account, agent }));
      }
      if (h.account) setSpend(await (await fetch(`/api/v1/spend/${h.account}`)).json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'API unreachable — start it with `pnpm api`');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Live agent log: the API publishes every /v1/verify outcome here (see
  // packages/api/src/server.ts). No session needed while dashboard auth is off.
  useEffect(() => {
    let source: EventSource | null = null;
    try {
      source = new EventSource('/api/v1/stream');
      source.addEventListener('decision', (event) => {
        try {
          pushFeed(JSON.parse((event as MessageEvent).data));
          setStreamState('open');
        } catch {
          /* malformed frame — ignore */
        }
      });
      source.onopen = () => setStreamState('open');
      source.onerror = () => setStreamState('closed');
    } catch {
      setStreamState('closed');
    }
    return () => source?.close();
  }, [pushFeed]);

  function buildAction(kind: Template, amountUsdc: string, toRecipient: string): { to: string; data: Hex } {
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
    if (kind === 'transfer') return { to: addrs.asset, data: encodeErc20Transfer(toRecipient as Address, amountIn) };
    if (kind === 'approve') return { to: addrs.asset, data: encodeErc20Approve(toRecipient as Address, amountIn) };
    return { to: addrs.asset, data: encodeErc20Approve(addrs.router as Address, UNLIMITED_APPROVAL) };
  }

  async function evaluate(kind: Template, amountUsdc: string, toRecipient: string): Promise<any | undefined> {
    const { to, data } = buildAction(kind, amountUsdc, toRecipient);
    const res = await fetch('/api/v1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: addrs.agent, action: { to, data, value: '0', chainId: 11155111 } }),
    });
    const body = await res.json();
    setSelected(body);
    pushFeed(body);
    if (health?.account) setSpend(await (await fetch(`/api/v1/spend/${health.account}`)).json());
    document.getElementById('verdict')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return body;
  }

  async function onFreePlay() {
    setBusy(true);
    try {
      await evaluate(template, amount, recipient);
    } catch (e) {
      setSelected({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const proven = proofsData?.proofs?.filter((p: any) => p.status === 'PROVEN').length ?? 0;
  const proofsTotal = proofsData?.proofs?.length ?? 0;

  return (
    <div className="pg">
      <header className="pg-hero">
        <div>
          <p className="pg-kicker">AgentProof · live demo</p>
          <h1 className="ap-display">Trust the agent to decide. Don&apos;t trust it to enforce its own limits.</h1>
          <p className="ap-dim">Every proposal below runs through the real policy engine. Nothing here is scripted.</p>
        </div>
        <div className="pg-hero__meta">
          <ThemeToggle />
          {error ? (
            <p className="pg-error">
              {error} <button type="button" className="ap-btn ap-btn--ghost" onClick={() => void load()}>Retry</button>
            </p>
          ) : health ? (
            <div className="pg-badges">
              <span className={`ap-chip ${health.mode === 'production' ? 'ap-chip--allow' : 'ap-chip--approval'}`}>{health.mode}</span>
              <span className="ap-dim ap-mono">{health.agent}</span>
              <span className="ap-dim">proofs {proven}/{proofsTotal}</span>
              <span className="ap-dim">
                <span className="ap-live-dot" aria-hidden="true" /> feed: {streamState}
              </span>
            </div>
          ) : (
            <p className="ap-dim">Connecting to the Verification API…</p>
          )}
        </div>
      </header>

      <Section n="1" title="The brain — what the agent wants">
        <p className="ap-dim">Two canonical price signals. Pressing Evaluate sends the proposal to <span className="ap-mono">/v1/verify</span> — the verdict is computed, never scripted.</p>
        <div className="pg-grid2">
          {SIGNALS.map((s, i) => (
            <div key={i} className="ap-card pg-signal">
              <p className="ap-dim ap-mono">{s.pair} @ {s.price} ({s.change}) — {s.note}</p>
              <p className="pg-quote">&ldquo;{s.reasoning}&rdquo;</p>
              <p className="pg-proposal">
                Proposal: <Amount baseUnits={toBaseUnits(s.amountUsdc).toString()} /> <span className="ap-dim">SWAP</span>{' '}
                <button type="button" className="ap-btn" onClick={() => void evaluate('swap-in', s.amountUsdc, addrs.account)}>
                  Evaluate
                </button>
              </p>
            </div>
          ))}
        </div>
      </Section>

      <Section n="2" title="The verdict — what the policy says" id="verdict">
        {selected && !selected.error ? (
          <div className={`ap-verdict ap-verdict--${selected.decision}`}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="ap-verdict__decision">{selected.decision}</span>
              <DecisionChip decision={selected.decision} />
              {selected.proof ? <ProofSeal property={selected.proof.property} status={selected.proof.status} /> : null}
            </div>
            <p className="ap-verdict__reason">{selected.reason}</p>
            {selected.intent ? <p className="ap-dim">{selected.intent.summary}</p> : null}
            {selected.intent?.outflow?.length ? (
              <div className="pg-outflow">
                {selected.intent.outflow.map((f: any, i: number) => (
                  <span key={i} className="ap-chip" title={`${f.asset}`}>
                    {short(f.asset)} · <Amount baseUnits={f.amount} /> · {f.provenance}
                  </span>
                ))}
              </div>
            ) : null}
            {selected.policyRows?.length ? (
              <div>
                {selected.policyRows.map((r: any, i: number) => (
                  <PolicyRow key={i} name={r.name ?? r.id} passed={r.passed !== false} observed={r.observed?.toString()} limit={r.limit?.toString()} />
                ))}
              </div>
            ) : null}
            {selected.enforcement ? (
              <p className="ap-dim">
                Advisory only — enforcement is the hook <span className="ap-mono">{short(selected.enforcement.hook)}</span> on{' '}
                <span className="ap-mono">{short(selected.enforcement.account)}</span> ({selected.enforcement.mode}).
                {selected.enforcement.unevaluatedPolicies?.length
                  ? ` Unevaluated: ${selected.enforcement.unevaluatedPolicies.map((u: any) => u.policy).join(', ')}`
                  : ''}
              </p>
            ) : null}
          </div>
        ) : selected?.error ? (
          <p className="pg-error">{selected.error}</p>
        ) : (
          <p className="ap-dim">No verdict yet — evaluate a proposal above, or free-play below.</p>
        )}
      </Section>

      <Section n="3" title="Free play — type your own attack">
        <div className="ap-card pg-form">
          <label className="ap-field">
            Template{' '}
            <select className="ap-select" value={template} onChange={(e) => setTemplate(e.target.value as Template)}>
              <option value="swap-in">swap exact-in (amountIn = amount)</option>
              <option value="swap-out">swap exact-out (amountInMaximum = amount — the trap)</option>
              <option value="transfer">ERC-20 transfer to recipient</option>
              <option value="approve">ERC-20 approve recipient</option>
              <option value="unlimited-approve">unlimited approval (always BLOCK)</option>
            </select>
          </label>
          <label className="ap-field">
            Amount (USDC) <input className="ap-input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </label>
          <label className="ap-field">
            Recipient <input className="ap-input ap-mono" value={recipient} onChange={(e) => setRecipient(e.target.value)} />
          </label>
          <div className="pg-btnrow">
            <button type="button" onClick={() => void onFreePlay()} disabled={busy} className="ap-btn">
              {busy ? 'Evaluating…' : 'Evaluate'}
            </button>
            <button type="button" className="ap-btn ap-btn--ghost" onClick={() => { setAmount('80'); setTemplate('swap-in'); }}>valid 80</button>
            <button type="button" className="ap-btn ap-btn--ghost" onClick={() => { setAmount('250'); setTemplate('swap-in'); }}>oversized 250</button>
            <button type="button" className="ap-btn ap-btn--ghost" onClick={() => { setAmount('50'); setTemplate('transfer'); setRecipient(ATTACKER); }}>injection</button>
          </div>
        </div>
      </Section>

      <Section n="4" title="The boundary — what happens without the SDK">
        <p className="ap-dim">
          The SDK is convenience. The hook is the boundary: close the SDK, sign a 250 USDC transfer directly with the
          session key, and the account reverts — <span className="ap-mono">ExceedsMaxTransaction</span> on a funded
          account. Run <span className="ap-mono">pnpm demo</span> step 09 to watch it.
        </p>
        <div className="pg-addrs">
          <span className="ap-dim">account</span>
          <AddrChip address={addrs.account} explorer={`${SEPOLIA_EXPLORER}/address/${addrs.account}`} />
          <span className="ap-dim">hook</span>
          <AddrChip address={health?.hook ?? FALLBACK.account} explorer={`${SEPOLIA_EXPLORER}/address/${health?.hook ?? ''}`} />
        </div>
      </Section>

      <Section n="5" title="The money — daily spend">
        {spend ? (
          <div className="ap-card pg-spend">
            <SpendRing spent={spend.spentGraph ?? '0'} limit={spend.limit ?? '1'} />
            <div>
              <Amount baseUnits={spend.spentGraph ?? '0'} />
              <p className="ap-dim">
                of <span className="ap-mono ap-tabular">{spend.limit}</span> limit · remaining{' '}
                <span className="ap-mono ap-tabular">{spend.remaining}</span>
                {spend.spentOnchain != null
                  ? ` · on-chain ${spend.spentOnchain} · reconciled ${String(spend.reconciled)}`
                  : ' · on-chain: n/a in simulation'}
              </p>
            </div>
          </div>
        ) : (
          <p className="ap-dim">Spend data appears once the API is reachable.</p>
        )}
      </Section>

      <Section n="6" title="The math — formal verification">
        <p className="ap-dim">
          <span className="ap-mono">MAX_TRANSFER</span> and <span className="ap-mono">DAILY_SPEND</span> over{' '}
          <span className="ap-mono">PolicyLib</span>, checked with solc SMTChecker. The hook itself is fuzzed, not
          proven — the table says which. No artifacts, no <span className="ap-mono">PROVEN</span>: the SDK reports{' '}
          <span className="ap-mono">NOT_RUN</span>.
        </p>
        {proofsData?.proofs?.length ? (
          <div className="ap-card pg-proofs">
            {proofsData.proofs.map((p: any, i: number) => (
              <div key={i} className="pg-proofrow">
                <span className="ap-mono">{p.property}</span>
                {p.status === 'PROVEN' ? (
                  <ProofSeal property={p.property} status={p.status} />
                ) : (
                  <DecisionChip decision={p.status} />
                )}
                <span className="ap-dim">
                  {p.tool ?? '—'}
                  {p.solverTimeMs != null ? ` · ${p.solverTimeMs} ms` : ''}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="ap-dim">Proof artifacts appear once the API is reachable.</p>
        )}
      </Section>

      <Section n="7" title="The identity — policy, published">
        {policyData ? (
          <div className="ap-card pg-identity">
            <p>
              <span className="ap-mono">{policyData.name}</span> · policyHash{' '}
              <span className="ap-mono">{short(policyData.policyHash)}</span>
            </p>
            <p className="ap-dim">
              {policyData.policy?.publishedPolicyHash
                ? `published ${short(policyData.policy.publishedPolicyHash)} · matches local: ${String(policyData.policy.matchesLocal)} · status ${policyData.policy.status}`
                : 'served from local file (no ENS resolver configured)'}
            </p>
            <details>
              <summary className="ap-dim">Raw policy document</summary>
              <pre className="ap-mono pg-raw">{JSON.stringify(policyData.policy?.document ?? policyData.policy, null, 2)}</pre>
            </details>
          </div>
        ) : (
          <p className="ap-dim">Policy data appears once the API is reachable.</p>
        )}
      </Section>

      <Section n="8" title={`Agent log — every verdict, live (${streamState})`}>
        {feed.length === 0 ? (
          <p className="ap-dim">Nothing yet. Evaluate something — it will appear here via the server-sent stream.</p>
        ) : (
          <ol className="ap-timeline">
            {feed.map((f, i) => (
              <li key={i}>
                <button type="button" className="ap-timeline__item" onClick={() => { setSelected(f); document.getElementById('verdict')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }}>
                  <span className={`ap-timeline__dot ap-timeline__dot--${f.decision}`} aria-hidden="true" />
                  <span className="ap-timeline__text">
                    <DecisionChip decision={f.decision} /> {f.intent?.summary ?? f.reason ?? ''}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <footer className="pg-footer">
        <p className="ap-dim">
          Advisory page. Enforcement is the on-chain hook. Amounts in base units (6 decimals); an unlimited approval
          counts as unbounded outflow and always blocks.
        </p>
      </footer>

      <style jsx global>{`
        .pg {
          max-width: 960px;
          margin: 0 auto;
          padding: 32px 24px 64px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .pg-hero {
          display: flex;
          justify-content: space-between;
          gap: 28px;
          flex-wrap: wrap;
          padding: 40px 0 20px;
        }
        .pg-hero h1 {
          font-size: clamp(30px, 4.6vw, 46px);
          letter-spacing: var(--tracking-tight);
          margin: 12px 0;
          max-width: 24ch;
        }
        .pg-kicker {
          font-family: var(--font-mono);
          font-size: var(--text-caption);
          font-weight: 600;
          letter-spacing: var(--tracking-wide);
          text-transform: uppercase;
          color: var(--teal-ink);
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .pg-kicker::after {
          content: '';
          height: 1px;
          width: 72px;
          background: var(--teal-line);
        }
        .pg-hero__meta {
          display: flex;
          flex-direction: column;
          gap: 12px;
          align-items: flex-end;
          justify-content: center;
        }
        .pg-badges {
          display: flex;
          gap: 10px;
          align-items: center;
          flex-wrap: wrap;
          justify-content: flex-end;
        }
        .pg section {
          margin-top: 34px;
          border-top: 1px solid var(--line);
          padding-top: 20px;
        }
        .pg section h2 {
          margin-bottom: 12px;
        }
        .pg-grid2 {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 14px;
        }
        @media (max-width: 720px) {
          .pg-grid2 {
            grid-template-columns: 1fr;
          }
        }
        .pg-signal {
          padding: 16px 18px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .pg-quote {
          font-size: var(--text-h3);
          font-style: italic;
          color: var(--ink-2);
          border-left: 3px solid var(--teal-line);
          padding-left: 12px;
        }
        .pg-proposal {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
          font-size: var(--text-small);
        }
        .pg-outflow {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .pg-form {
          padding: 22px 24px;
          display: grid;
          gap: 14px;
        }
        .pg-btnrow {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }
        .pg-addrs {
          display: flex;
          gap: 10px;
          align-items: center;
          flex-wrap: wrap;
          margin-top: 12px;
        }
        .pg-spend {
          padding: 20px 22px;
          display: flex;
          gap: 22px;
          align-items: center;
          flex-wrap: wrap;
        }
        .pg-proofs {
          padding: 8px 20px;
        }
        .pg-proofrow {
          display: flex;
          gap: 12px;
          align-items: center;
          padding: 10px 0;
          border-bottom: 1px solid var(--line);
          font-size: var(--text-small);
        }
        .pg-proofrow:last-child {
          border-bottom: 0;
        }
        .pg-identity {
          padding: 16px 20px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          font-size: var(--text-small);
        }
        .pg-raw {
          font-size: 12px;
          overflow: auto;
          background: var(--bg-2);
          border: 1px solid var(--line);
          border-radius: var(--radius-sm);
          padding: 12px;
        }
        .pg-error {
          color: var(--red);
          font-size: var(--text-small);
        }
        .pg-footer {
          margin-top: 32px;
          border-top: 1px solid var(--line);
          padding-top: 14px;
        }
      `}</style>
    </div>
  );
}

function Section({ n, title, children, id }: { n: string; title: string; children: React.ReactNode; id?: string }) {
  return (
    <section id={id}>
      <h2 className="ap-section-title">
        <span className="ap-section-num">{n}</span> {title}
      </h2>
      {children}
    </section>
  );
}
