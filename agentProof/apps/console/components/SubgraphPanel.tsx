'use client';

import { useEffect, useState } from 'react';
import { GRAPH_ENDPOINT, SEPOLIA_EXPLORER } from '@/lib/deployments';
import { Amount, short } from '../../shared-design/ui';

/**
 * Live history, straight from The Graph.
 *
 * Queried from the browser rather than proxied through the API on purpose: the
 * point of this panel is that the history does not depend on our service being
 * honest. Anyone can run this query themselves against the same public
 * endpoint, and the endpoint is printed above the results so they can.
 */

const QUERY = `{
  agents {
    id
    policyHash
    hook
    asset
    installedAt
    totalOutflow
    executionCount
  }
  executions(first: 15, orderBy: timestamp, orderDirection: desc) {
    id
    account
    target
    outflow
    day
    transactionHash
  }
  dailyAggregates(first: 7, orderBy: day, orderDirection: desc) {
    id
    account
    day
    totalOutflow
    executionCount
    largestOutflow
  }
}`;

interface Agent {
  id: string;
  policyHash: string;
  hook: string;
  asset: string;
  installedAt: string;
  totalOutflow: string;
  executionCount: number;
}

interface Execution {
  id: string;
  account: string;
  target: string;
  outflow: string;
  day: number;
  transactionHash: string;
}

interface Aggregate {
  id: string;
  account: string;
  day: number;
  totalOutflow: string;
  executionCount: number;
  largestOutflow: string;
}

export function SubgraphPanel() {
  const [data, setData] = useState<{ agents: Agent[]; executions: Execution[]; dailyAggregates: Aggregate[] }>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(GRAPH_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: QUERY }),
          signal: AbortSignal.timeout(12_000),
        });
        const body = await response.json();
        if (body.errors?.length) throw new Error(body.errors[0].message);
        if (!body.data) throw new Error('the subgraph returned no data');
        setData(body.data);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="sg">
      <p className="sg__endpoint ap-mono">
        POST{' '}
        <a href={GRAPH_ENDPOINT} target="_blank" rel="noreferrer noopener">
          {GRAPH_ENDPOINT}
        </a>
      </p>

      {loading ? (
        <p className="ap-dim">Querying the subgraph…</p>
      ) : error ? (
        <p className="sg__error">
          Subgraph query failed: {error}. The history below the fold is unavailable — this says nothing about whether
          the hook is enforcing, only that the indexer did not answer.
        </p>
      ) : (
        <>
          <div className="sg__block">
            <span className="sg__label">Protected accounts the indexer has seen</span>
            {data?.agents.length ? (
              <table className="sg__table">
                <thead>
                  <tr>
                    <th>account</th>
                    <th>policy hash</th>
                    <th>executions</th>
                    <th>total outflow</th>
                  </tr>
                </thead>
                <tbody>
                  {data.agents.map((agent) => (
                    <tr key={agent.id}>
                      <td>
                        <a
                          href={`${SEPOLIA_EXPLORER}/address/${agent.id}`}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="ap-mono"
                        >
                          {short(agent.id)} ↗
                        </a>
                      </td>
                      <td className="ap-mono">{short(agent.policyHash)}</td>
                      <td className="ap-mono ap-tabular">{agent.executionCount}</td>
                      <td>
                        <Amount baseUnits={agent.totalOutflow} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="ap-dim">No account has installed the policy hook in the indexed range.</p>
            )}
          </div>

          <div className="sg__block">
            <span className="sg__label">Daily aggregates — what the chain admitted, per UTC day</span>
            {data?.dailyAggregates.length ? (
              <table className="sg__table">
                <thead>
                  <tr>
                    <th>day</th>
                    <th>executions</th>
                    <th>total outflow</th>
                    <th>largest</th>
                  </tr>
                </thead>
                <tbody>
                  {data.dailyAggregates.map((aggregate) => (
                    <tr key={aggregate.id}>
                      <td className="ap-mono">{aggregate.day}</td>
                      <td className="ap-mono ap-tabular">{aggregate.executionCount}</td>
                      <td>
                        <Amount baseUnits={aggregate.totalOutflow} />
                      </td>
                      <td>
                        <Amount baseUnits={aggregate.largestOutflow} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="ap-dim">
                No aggregates indexed yet. The hook is deployed but has not recorded a spend in the indexed range.
              </p>
            )}
          </div>

          <div className="sg__block">
            <span className="sg__label">Executions the hook let through</span>
            {data?.executions.length ? (
              <table className="sg__table">
                <thead>
                  <tr>
                    <th>account</th>
                    <th>target</th>
                    <th>outflow (measured)</th>
                    <th>tx</th>
                  </tr>
                </thead>
                <tbody>
                  {data.executions.map((execution) => (
                    <tr key={execution.id}>
                      <td className="ap-mono">{short(execution.account)}</td>
                      <td className="ap-mono">{short(execution.target)}</td>
                      <td>
                        <Amount baseUnits={execution.outflow} />
                      </td>
                      <td>
                        <a
                          href={`${SEPOLIA_EXPLORER}/tx/${execution.transactionHash}`}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="ap-mono"
                        >
                          {short(execution.transactionHash)} ↗
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="ap-dim">
                No executions indexed yet. Nothing has been admitted through the hook in the indexed range — which is
                itself a true statement about the chain, not a loading state.
              </p>
            )}
          </div>
        </>
      )}

      <style jsx>{`
        .sg {
          display: flex;
          flex-direction: column;
          gap: 20px;
        }
        .sg__endpoint {
          font-size: var(--text-caption);
          color: var(--ink-3);
          overflow-wrap: anywhere;
        }
        .sg__block {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .sg__label {
          font-family: var(--font-mono);
          font-size: var(--text-caption);
          letter-spacing: var(--tracking-wide);
          text-transform: uppercase;
          color: var(--ink-4);
        }
        .sg__table {
          width: 100%;
          border-collapse: collapse;
          font-size: var(--text-small);
          display: block;
          overflow-x: auto;
        }
        .sg__table th {
          text-align: left;
          font-weight: 500;
          color: var(--ink-3);
          font-size: var(--text-caption);
          text-transform: uppercase;
          letter-spacing: var(--tracking-wide);
          padding: 6px 14px 6px 0;
          border-bottom: 1px solid var(--line-2);
        }
        .sg__table td {
          padding: 9px 14px 9px 0;
          border-bottom: 1px solid var(--line);
          white-space: nowrap;
        }
        .sg__error {
          color: var(--amber);
          font-size: var(--text-small);
          line-height: var(--leading-body);
          max-width: 70ch;
        }
      `}</style>
    </div>
  );
}
