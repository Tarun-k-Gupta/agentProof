'use client';

import type { Spend } from '@/lib/types';
import { percent, usdc } from '@/lib/format';

/**
 * Daily-spend gauge, reconciled between the subgraph and the chain.
 *
 * The reconciliation state is shown rather than hidden. An indexer that is
 * behind the chain is normal; a dashboard that quietly renders the lower of two
 * disagreeing numbers as "spent today" is how an operator ends up believing
 * there is more headroom than there is.
 */
export function SpendGauge({ spend, error }: { spend?: Spend; error?: string }) {
  if (error) {
    return (
      <div className="gauge-wrap">
        <p className="err">Daily spend unavailable — {error}</p>
        <style jsx>{`
          .gauge-wrap { display: flex; align-items: center; height: 100%; padding: 0 20px; }
          .err { color: var(--red); font-size: 12.5px; }
        `}</style>
      </div>
    );
  }

  if (!spend) {
    return (
      <div className="gauge-wrap">
        <p className="idle">Loading daily spend…</p>
        <style jsx>{`
          .gauge-wrap { display: flex; align-items: center; height: 100%; padding: 0 20px; }
          .idle { color: var(--ink-4); font-size: 12.5px; }
        `}</style>
      </div>
    );
  }

  const filled = percent(spend.spentGraph, spend.limit);
  const state =
    spend.reconciled === null ? 'unreconciled' : spend.reconciled ? 'agreed' : 'diverged';

  return (
    <div className="gauge-wrap">
      <div className="labels">
        <span className="title">Daily spend</span>
        <span className="figures tabular">
          <strong>{usdc(spend.spentGraph)}</strong>
          <span className="of"> of {usdc(spend.limit)} USDC</span>
        </span>
      </div>

      <div
        className="track"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(filled)}
        aria-label={`Daily spend: ${usdc(spend.spentGraph)} of ${usdc(spend.limit)} USDC`}
      >
        <div className={`fill ${filled >= 100 ? 'full' : filled >= 80 ? 'near' : ''}`} style={{ width: `${filled}%` }} />
      </div>

      <p className={`recon recon-${state}`}>
        {state === 'agreed' ? (
          <>Graph and chain agree</>
        ) : state === 'diverged' ? (
          <>
            Indexer lag: subgraph {usdc(spend.spentGraph)}, chain {usdc(spend.spentOnchain ?? '0')} — using whichever
            permits less
          </>
        ) : (
          <>No RPC configured, so the on-chain accumulator was not read</>
        )}
      </p>

      <style jsx>{`
        .gauge-wrap {
          display: flex;
          flex-direction: column;
          justify-content: center;
          gap: 6px;
          height: 100%;
          padding: 0 20px;
        }
        .labels { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
        .title {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.07em;
          text-transform: uppercase;
          color: var(--ink-4);
        }
        .figures { font-size: 13px; }
        .of { color: var(--ink-4); }
        .track {
          height: 8px;
          border-radius: 999px;
          background: var(--bg-3);
          overflow: hidden;
        }
        .fill {
          height: 100%;
          border-radius: 999px;
          background: var(--teal);
          transition: width 420ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        .fill.near { background: var(--amber); }
        .fill.full { background: var(--red); }
        .recon { font-size: 11.5px; color: var(--ink-4); }
        .recon-diverged { color: var(--amber); }
      `}</style>
    </div>
  );
}
