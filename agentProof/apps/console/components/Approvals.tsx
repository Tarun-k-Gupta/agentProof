'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import type { ApprovalRequest } from '@/lib/types';
import { isUnbounded, shortAddress, usdc } from '@/lib/format';

/**
 * The dashboard's only control.
 *
 * It resolves a request the policy engine already escalated. It cannot create
 * one, it cannot approve anything that was not offered, and it never evaluates
 * policy or signs a transaction. Close this page and nothing changes except
 * that nobody is watching.
 *
 * The decoded intent is rendered in words — recipient, asset, amount — because
 * an approval screen showing raw calldata is a consent dialog nobody can give
 * informed consent to.
 */
export function Approvals({
  approvals,
  onResolved,
}: {
  approvals: ApprovalRequest[];
  onResolved: (id: string, how: 'approved' | 'declined') => void;
}) {
  if (approvals.length === 0) return null;

  return (
    <div className="stack" role="region" aria-label="Approvals awaiting the owner" aria-live="assertive">
      {approvals.map((request) => (
        <ApprovalCard key={request.id} request={request} onResolved={onResolved} />
      ))}
      <style jsx>{`
        .stack { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; }
      `}</style>
    </div>
  );
}

function ApprovalCard({
  request,
  onResolved,
}: {
  request: ApprovalRequest;
  onResolved: (id: string, how: 'approved' | 'declined') => void;
}) {
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null);
  const [error, setError] = useState<string>();

  const resolve = async (approved: boolean) => {
    setBusy(approved ? 'approve' : 'decline');
    setError(undefined);
    const result = await api.approve(request.id, approved);
    setBusy(null);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (!result.value.settled) {
      setError(result.value.error ?? 'that approval is no longer pending');
      return;
    }
    onResolved(request.id, approved ? 'approved' : 'declined');
  };

  const amount = isUnbounded(request.intent.notionalUSDC)
    ? 'an UNBOUNDED amount'
    : `${usdc(request.intent.notionalUSDC)} USDC`;

  return (
    <article className="card">
      <header>
        <span className="tag">Owner approval required</span>
        <span className="reason">{request.reason}</span>
      </header>

      <p className="what">
        {request.intent.summary}
        <br />
        <span className="detail">
          worth <strong>{amount}</strong>
          {request.intent.counterparty ? <> to {shortAddress(request.intent.counterparty)}</> : null}
        </span>
      </p>

      {error ? <p className="error">{error}</p> : null}

      <div className="actions">
        <button type="button" className="decline" disabled={busy !== null} onClick={() => void resolve(false)}>
          {busy === 'decline' ? 'Declining…' : 'Decline'}
        </button>
        <button type="button" className="approve" disabled={busy !== null} onClick={() => void resolve(true)}>
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </button>
      </div>

      <style jsx>{`
        .card {
          border: 1px solid var(--amber-line);
          background: var(--amber-bg);
          border-radius: var(--radius);
          padding: 14px 16px;
          box-shadow: var(--shadow-1);
        }
        header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
        .tag {
          font-size: 10.5px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--amber);
        }
        .reason { font-size: 12.5px; color: var(--ink-3); }
        .what { font-size: 14px; margin-top: 8px; line-height: 1.5; }
        .detail { color: var(--ink-2); font-size: 13px; }
        .error { color: var(--red); font-size: 12.5px; margin-top: 8px; }
        .actions { display: flex; gap: 8px; margin-top: 12px; }
        button {
          min-height: 44px;
          padding: 0 18px;
          border-radius: var(--radius-sm);
          border: 1px solid;
          cursor: pointer;
          font-weight: 600;
          font-size: 13px;
          transition: filter 120ms ease;
        }
        button:disabled { opacity: 0.6; cursor: progress; }
        .decline { background: var(--bg); border-color: var(--line-2); color: var(--ink-2); }
        .decline:hover:not(:disabled) { background: var(--bg-2); }
        .approve { background: var(--teal); border-color: var(--teal); color: #fff; margin-left: auto; }
        .approve:hover:not(:disabled) { filter: brightness(1.06); }
      `}</style>
    </article>
  );
}
