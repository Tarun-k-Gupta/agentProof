'use client';

import type { NormalizedIntent } from '@/lib/types';
import { isUnbounded, SEPOLIA_EXPLORER, shortAddress, usdc } from '@/lib/format';
import { Field, ProvenanceTag } from './primitives';

/**
 * The normalized intent, in full.
 *
 * The demo's whole argument is that a policy decision is made on what the
 * calldata does, not on what the agent says it does — so the decoded shape has
 * to be visible, not summarised into a sentence.
 */
export function IntentCard({ intent }: { intent: NormalizedIntent }) {
  const unbounded = isUnbounded(intent.notionalUSDC);

  return (
    <div className="intent">
      <p className="summary">{intent.summary}</p>

      <dl className="fields">
        <Field label="Kind">
          <span className="kind">{intent.kind}</span>
        </Field>
        <Field label="Notional">
          <strong className={unbounded ? 'unbounded tabular' : 'tabular'}>
            {unbounded ? 'UNBOUNDED' : `${usdc(intent.notionalUSDC)} USDC`}
          </strong>
        </Field>
        <Field label="Target" mono>
          <ExplorerLink address={intent.target} />
        </Field>
        {intent.counterparty ? (
          <Field label="Counterparty" mono>
            <ExplorerLink address={intent.counterparty} />
          </Field>
        ) : null}
        <Field label="Selector" mono>
          {intent.selector}
        </Field>
        {intent.nativeValue !== '0' ? (
          <Field label="Native value" mono>
            {intent.nativeValue} wei
          </Field>
        ) : null}
      </dl>

      {intent.outflow.length > 0 ? (
        <div className="outflow">
          <h3>Worst-case outflow</h3>
          <ul>
            {intent.outflow.map((flow, index) => (
              <li key={`${flow.asset}-${index}`}>
                <span className="mono">{shortAddress(flow.asset)}</span>
                <span className="tabular amount">
                  {isUnbounded(flow.amount) ? 'UNBOUNDED' : usdc(flow.amount)}
                </span>
                <ProvenanceTag provenance={flow.provenance} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <style jsx>{`
        .intent { display: flex; flex-direction: column; gap: 14px; }
        .summary {
          font-size: 15px;
          font-weight: 550;
          line-height: 1.45;
          color: var(--ink);
        }
        .fields { margin: 0; }
        .kind {
          font-family: var(--mono);
          font-size: 11px;
          font-weight: 600;
          padding: 2px 7px;
          border-radius: 5px;
          background: var(--bg-3);
          color: var(--ink-2);
        }
        .unbounded { color: var(--red); }
        .outflow h3 {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--ink-4);
          margin-bottom: 6px;
        }
        .outflow ul { display: flex; flex-direction: column; gap: 4px; }
        .outflow li {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 7px 10px;
          background: var(--bg-2);
          border: 1px solid var(--line);
          border-radius: var(--radius-sm);
          font-size: 12.5px;
        }
        .amount { margin-left: auto; font-weight: 600; }
      `}</style>
    </div>
  );
}

function ExplorerLink({ address }: { address: string }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return <>{address}</>;
  return (
    <a href={`${SEPOLIA_EXPLORER}/address/${address}`} target="_blank" rel="noreferrer noopener">
      {address}
    </a>
  );
}
