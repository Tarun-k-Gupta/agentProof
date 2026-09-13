'use client';

import type { PolicyRow, Verdict } from '@/lib/types';
import { isUnbounded, usdc } from '@/lib/format';
import { ProvenanceTag } from './primitives';

/**
 * Per-policy pass/fail, in evaluation order.
 *
 * This is the table that answers "why", and the reason a policy engine beats a
 * boolean. Rows the deployment could not evaluate are listed too, greyed and
 * labelled — a reader has to be able to tell "this passed every policy" apart
 * from "this passed every policy we were able to check".
 */
export function PolicyRows({ verdict }: { verdict: Verdict }) {
  const unevaluated = verdict.enforcement?.unevaluatedPolicies ?? [];

  return (
    <ol className="rows">
      {verdict.policyRows.map((row) => (
        <Row key={row.id} row={row} />
      ))}

      {unevaluated.map((item) => (
        <li key={item.policy} className="row row-skip">
          <span className="mark" aria-hidden="true">
            –
          </span>
          <span className="name">{item.policy}</span>
          <span className="detail">not evaluated — {item.reason}</span>
        </li>
      ))}

      <style jsx>{`
        .rows { display: flex; flex-direction: column; gap: 1px; }
        .row {
          display: grid;
          grid-template-columns: 20px 148px 1fr;
          gap: 10px;
          align-items: baseline;
          padding: 8px 10px;
          border-radius: var(--radius-sm);
          font-size: 13px;
        }
        .row-skip { color: var(--ink-4); background: var(--bg-2); }
        .mark { font-family: var(--mono); font-weight: 700; text-align: center; }
        .name { font-weight: 550; }
        .detail { color: var(--ink-3); min-width: 0; }
        @media (max-width: 560px) {
          .row { grid-template-columns: 20px 1fr; }
          .detail { grid-column: 2; }
        }
      `}</style>
    </ol>
  );
}

function Row({ row }: { row: PolicyRow }) {
  const failed = !row.passed;
  const escalated = row.decision === 'REQUIRE_APPROVAL';

  return (
    <li className={`row ${failed ? (escalated ? 'is-approval' : 'is-fail') : 'is-pass'}`}>
      <span className="mark" aria-hidden="true">
        {failed ? (escalated ? '!' : '✗') : '✓'}
      </span>
      <span className="name">
        {row.name}
        {row.formallyVerified ? (
          <abbr title="This policy's arithmetic is formally verified — see the proof drawer.">
            {' '}
            ✦
          </abbr>
        ) : null}
      </span>
      <span className="detail">
        {row.reason ? <span>{row.reason}</span> : <Numbers row={row} />}{' '}
        <ProvenanceTag provenance={row.provenance} />
      </span>

      <span className="sr-only">{failed ? (escalated ? 'needs approval' : 'failed') : 'passed'}</span>

      <style jsx>{`
        .row {
          display: grid;
          grid-template-columns: 20px 148px 1fr;
          gap: 10px;
          align-items: baseline;
          padding: 8px 10px;
          border-radius: var(--radius-sm);
          font-size: 13px;
        }
        .is-pass .mark { color: var(--teal); }
        .is-fail { background: var(--red-bg); }
        .is-fail .mark { color: var(--red); }
        .is-approval { background: var(--amber-bg); }
        .is-approval .mark { color: var(--amber); }
        .mark { font-family: var(--mono); font-weight: 700; text-align: center; }
        .name { font-weight: 550; }
        .detail { color: var(--ink-3); min-width: 0; }
        abbr { text-decoration: none; color: var(--teal); cursor: help; }
        @media (max-width: 560px) {
          .row { grid-template-columns: 20px 1fr; }
          .detail { grid-column: 2; }
        }
      `}</style>
    </li>
  );
}

function Numbers({ row }: { row: PolicyRow }) {
  if (!row.limit && !row.observed) return <span>passed</span>;
  const observed = row.observed ? (isUnbounded(row.observed) ? 'UNBOUNDED' : usdc(row.observed)) : '—';
  return (
    <span className="tabular">
      {observed} of {row.limit ? usdc(row.limit) : '—'}
    </span>
  );
}
