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

const WETH_SEPOLIA = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14' as Address;
const ATTACKER = '0x000000000000000000000000000000000000dead' as Address;

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

function short(addr: string): string {
  return addr.length > 14 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
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
    <main style={{ maxWidth: 920, margin: '0 auto', padding: 28, color: '#18201f' }}>
      <header style={{ borderBottom: '2px solid #0d9488', paddingBottom: 12 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>
          AgentProof <span style={{ fontWeight: 400, color: '#666' }}>— live demo</span>
        </h1>
        <p style={{ color: '#555', fontSize: 14, margin: '6px 0 0' }}>
          Trust the agent to decide. Don&apos;t trust it to enforce its own limits.
        </p>
        {error ? (
          <p style={{ color: '#b91c1c' }}>
            {error} <button onClick={() => void load()}>Retry</button>
          </p>
        ) : health ? (
          <p style={{ fontSize: 13, color: '#555' }}>
            <Badge text={health.mode} tone={health.mode === 'production' ? 'good' : 'warn'} /> agent {health.agent} ·
            policy <code>{short(health.policyHash)}</code> · proofs {proven}/{proofsTotal} ·{' '}
            <span title="server-sent event stream">live feed: {streamState}</span>
          </p>
        ) : (
          <p style={{ fontSize: 13, color: '#777' }}>Connecting to the Verification API…</p>
        )}
      </header>

      {/* 1 · THE BRAIN */}
      <Section n="1" title="The brain — what the agent wants">
        <p style={dim}>
          Two canonical price signals from <code>apps/agents/trader/index.ts</code>, replayed deterministically.
          Pressing Evaluate sends the proposal to the real <code>/v1/verify</code> engine — the verdict is computed,
          never scripted. The live brain (<code>pnpm trader</code>, OpenRouter wired) proposes different amounts on
          different days; the verdicts below would still be computed the same way.
        </p>
        {SIGNALS.map((s, i) => (
          <div key={i} style={card}>
            <p style={{ margin: 0, fontSize: 13, color: '#666' }}>
              {s.pair} @ {s.price} ({s.change}) — {s.note}
            </p>
            <p style={{ margin: '6px 0', fontStyle: 'italic' }}>&ldquo;{s.reasoning}&rdquo;</p>
            <p style={{ margin: '0 0 8px', fontSize: 13 }}>
              Proposal: <strong>SWAP {s.amountUsdc} USDC</strong>{' '}
              <button onClick={() => void evaluate('swap-in', s.amountUsdc, addrs.account)} style={btn}>
                Evaluate
              </button>
            </p>
          </div>
        ))}
      </Section>

      {/* 2 · THE VERDICT */}
      <Section n="2" title="The verdict — what the policy says">
        {selected && !selected.error ? (
          <div>
            <h3 style={{ margin: '0 0 6px' }}>
              <DecisionChip decision={selected.decision} />{' '}
              <span style={{ fontWeight: 400, fontSize: 14 }}>{selected.reason}</span>
            </h3>
            {selected.intent ? <p style={dim}>Intent: {selected.intent.summary}</p> : null}
            {selected.policyRows?.length ? (
              <table style={table}>
                <thead>
                  <tr>
                    <th style={th}>policy</th>
                    <th style={th}>observed</th>
                    <th style={th}>limit</th>
                    <th style={th}>provenance</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.policyRows.map((r: any, i: number) => (
                    <tr key={i}>
                      <td style={td}>
                        {r.passed === false ? '✖ ' : '✔ '}
                        {r.name ?? r.id}
                      </td>
                      <td style={td}>{r.observed ?? '—'}</td>
                      <td style={td}>{r.limit ?? '—'}</td>
                      <td style={td}>{r.provenance ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {selected.proof ? (
              <p style={dim}>
                Invariant <code>{selected.proof.property}</code>: <strong>{selected.proof.status}</strong> (
                {selected.proof.tool}, {selected.proof.solverTimeMs} ms)
              </p>
            ) : null}
            {selected.enforcement ? (
              <p style={{ fontSize: 12, color: '#777' }}>
                Advisory only — enforcement is the hook {short(selected.enforcement.hook)} on{' '}
                {short(selected.enforcement.account)} ({selected.enforcement.mode}).
                {selected.enforcement.unevaluatedPolicies?.length
                  ? ` Unevaluated: ${selected.enforcement.unevaluatedPolicies.map((u: any) => `${u.policy} (${u.reason})`).join('; ')}`
                  : ''}
              </p>
            ) : null}
          </div>
        ) : selected?.error ? (
          <p style={{ color: '#b91c1c' }}>{selected.error}</p>
        ) : (
          <p style={dim}>No verdict yet — evaluate a proposal above, or free-play below.</p>
        )}
      </Section>

      {/* 3 · FREE PLAY */}
      <Section n="3" title="Free play — type your own attack">
        <div style={{ display: 'grid', gap: 10 }}>
          <label style={lbl}>
            Template{' '}
            <select value={template} onChange={(e) => setTemplate(e.target.value as Template)}>
              <option value="swap-in">swap exact-in (amountIn = amount)</option>
              <option value="swap-out">swap exact-out (amountInMaximum = amount — the trap)</option>
              <option value="transfer">ERC-20 transfer to recipient</option>
              <option value="approve">ERC-20 approve recipient</option>
              <option value="unlimited-approve">unlimited approval (always BLOCK)</option>
            </select>
          </label>
          <label style={lbl}>
            Amount (USDC){' '}
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" style={{ width: 120 }} />
          </label>
          <label style={lbl}>
            Recipient{' '}
            <input value={recipient} onChange={(e) => setRecipient(e.target.value)} style={{ width: 400 }} />
          </label>
          <div>
            <button onClick={() => void onFreePlay()} disabled={busy} style={btnLg}>
              {busy ? 'Evaluating…' : 'Evaluate'}
            </button>{' '}
            <button onClick={() => { setAmount('80'); setTemplate('swap-in'); }} style={btn}>valid 80</button>{' '}
            <button onClick={() => { setAmount('250'); setTemplate('swap-in'); }} style={btn}>oversized 250</button>{' '}
            <button onClick={() => { setAmount('50'); setTemplate('transfer'); setRecipient(ATTACKER); }} style={btn}>
              injection → {short(ATTACKER)}
            </button>
          </div>
        </div>
      </Section>

      {/* 4 · THE BOUNDARY */}
      <Section n="4" title="The boundary — what happens without the SDK">
        <p style={dim}>
          The demo&apos;s key moment (<code>scripts/demo-runner.ts</code> step 09): the SDK is closed and a 250 USDC
          transfer is signed directly with the session key. No policy engine is consulted. The ERC-7579 hook sits
          inside the account&apos;s execution path, so the transaction <strong>reverts on chain</strong> (
          <code>ExceedsMaxTransaction</code>). Run <code>pnpm demo</code> to watch it; account{' '}
          <code>{short(addrs.account)}</code>, hook <code>{short(health?.hook ?? '0x0000000000000000000000000000000000000000')}</code>.
        </p>
      </Section>

      {/* 5 · THE MONEY */}
      <Section n="5" title="The money — daily spend">
        {spend ? (
          <p style={{ fontSize: 14 }}>
            Spent today <strong>{spend.spentGraph}</strong> / limit {spend.limit} · remaining {spend.remaining}
            {spend.spentOnchain != null
              ? ` · on-chain ${spend.spentOnchain} · reconciled ${String(spend.reconciled)}`
              : ' · on-chain: n/a in simulation'}
          </p>
        ) : (
          <p style={dim}>Spend data appears once the API is reachable.</p>
        )}
      </Section>

      {/* 6 · THE MATH */}
      <Section n="6" title="The math — formal verification">
        <p style={dim}>
          <code>MAX_TRANSFER</code> and <code>DAILY_SPEND</code> over <code>PolicyLib</code>, checked with solc
          SMTChecker (CHC). The hook itself is fuzzed, not proven — the page says which. Until{' '}
          <code>pnpm verify:formal</code> runs, the SDK reports <code>NOT_RUN</code>, never <code>PROVEN</code>.
        </p>
        {proofsData?.proofs?.length ? (
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>property</th>
                <th style={th}>status</th>
                <th style={th}>tool</th>
                <th style={th}>time</th>
              </tr>
            </thead>
            <tbody>
              {proofsData.proofs.map((p: any, i: number) => (
                <tr key={i}>
                  <td style={td}>{p.property}</td>
                  <td style={td}>{p.status === 'PROVEN' ? '✔ PROVEN' : p.status}</td>
                  <td style={td}>{p.tool ?? '—'}</td>
                  <td style={td}>{p.solverTimeMs != null ? `${p.solverTimeMs} ms` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p style={dim}>Proof artifacts appear once the API is reachable.</p>
        )}
      </Section>

      {/* 7 · THE IDENTITY */}
      <Section n="7" title="The identity — policy, published">
        {policyData ? (
          <div style={{ fontSize: 13 }}>
            <p style={{ margin: '0 0 6px' }}>
              <code>{policyData.name}</code> · policyHash <code>{short(policyData.policyHash)}</code>
              {policyData.policy?.publishedPolicyHash
                ? ` · published ${short(policyData.policy.publishedPolicyHash)} · matches local: ${String(policyData.policy.matchesLocal)} · status ${policyData.policy.status}`
                : ' · served from local file (no ENS resolver configured)'}
            </p>
            <details>
              <summary>Raw policy document</summary>
              <pre style={{ fontSize: 12, overflow: 'auto' }}>{JSON.stringify(policyData.policy?.document ?? policyData.policy, null, 2)}</pre>
            </details>
          </div>
        ) : (
          <p style={dim}>Policy data appears once the API is reachable.</p>
        )}
      </Section>

      {/* 8 · AGENT LOG */}
      <Section n="8" title={`Agent log — every verdict, live (${streamState})`}>
        {feed.length === 0 ? (
          <p style={dim}>Nothing yet. Evaluate something — it will appear here via the server-sent stream.</p>
        ) : (
          <ol style={{ paddingLeft: 18, margin: 0, display: 'grid', gap: 8 }}>
            {feed.map((f, i) => (
              <li key={i} style={{ fontSize: 13 }}>
                <button onClick={() => setSelected(f)} style={{ ...btn, borderColor: '#0d9488' }} title="inspect">
                  <DecisionChip decision={f.decision} />
                </button>{' '}
                {f.intent?.summary ?? f.reason ?? JSON.stringify(f)}
              </li>
            ))}
          </ol>
        )}
      </Section>

      <footer style={{ marginTop: 28, borderTop: '1px solid #e4e9e8', paddingTop: 12, fontSize: 12, color: '#777' }}>
        This page is advisory. Enforcement is the on-chain hook. Amounts in base units (6 decimals); an unlimited
        approval counts as unbounded outflow and always blocks.
      </footer>
    </main>
  );
}

function Section({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 24, borderTop: '1px solid #e4e9e8', paddingTop: 14 }}>
      <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>
        <span style={{ color: '#0d9488' }}>{n} ·</span> {title}
      </h2>
      {children}
    </section>
  );
}

function DecisionChip({ decision }: { decision?: string }) {
  const color = decision === 'ALLOW' ? '#0d9488' : decision === 'BLOCK' ? '#b91c1c' : '#b45309';
  return <span style={{ color, fontWeight: 700 }}>{decision ?? '—'}</span>;
}

function Badge({ text, tone }: { text: string; tone: 'good' | 'warn' }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        padding: '2px 8px',
        borderRadius: 5,
        border: '1px solid #ccc',
        color: tone === 'good' ? '#0d9488' : '#b45309',
      }}
    >
      {text}
    </span>
  );
}

const dim: React.CSSProperties = { fontSize: 13, color: '#555' };
const card: React.CSSProperties = {
  border: '1px solid #e4e9e8',
  borderRadius: 8,
  padding: '10px 14px',
  marginBottom: 10,
};
const btn: React.CSSProperties = { minHeight: 32, padding: '0 12px', cursor: 'pointer' };
const btnLg: React.CSSProperties = { minHeight: 44, padding: '0 20px', cursor: 'pointer' };
const lbl: React.CSSProperties = { fontSize: 14 };
const table: React.CSSProperties = { borderCollapse: 'collapse', fontSize: 13, width: '100%' };
const th: React.CSSProperties = { textAlign: 'left', borderBottom: '2px solid #ccc', padding: '4px 8px', color: '#666' };
const td: React.CSSProperties = { borderBottom: '1px solid #eee', padding: '4px 8px' };
