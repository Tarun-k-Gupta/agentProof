'use client';

import { useState } from 'react';

/**
 * The product, in two blocks.
 *
 * An npm install line and the smallest useful call. Everything a developer
 * needs to believe this is a real package rather than a demo site.
 */

const SNIPPET = `const guard = await createAgentProof({ agent: 'trader.agentproof.eth' });

const { decision, reason } = await guard.verify(tx);
if (decision !== 'ALLOW') return stop(reason);

await wallet.send(tx);`;

export function Install() {
  return (
    <div className="inst">
      <Copyable text="npm i @agentproof/sdk" mono prefix="$" />
      <pre className="inst__code ap-mono">
        <code>{SNIPPET}</code>
      </pre>
      <p className="inst__or">
        No install? The same check over HTTP: <code className="ap-mono">POST /v1/verify</code>
      </p>
    </div>
  );
}

function Copyable({ text, prefix }: { text: string; mono?: boolean; prefix?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="cp"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        } catch {
          /* clipboard unavailable — the command is still readable */
        }
      }}
      aria-label={`Copy: ${text}`}
    >
      {prefix ? <span className="cp__prefix">{prefix}</span> : null}
      <span className="cp__text ap-mono">{text}</span>
      <span className="cp__action">{copied ? 'copied' : 'copy'}</span>

      <style jsx>{`
        .cp {
          display: flex;
          align-items: center;
          gap: 10px;
          width: 100%;
          padding: 13px 15px;
          border-radius: var(--radius);
          border: 1px solid var(--line-2);
          background: var(--card);
          font: inherit;
          color: inherit;
          cursor: pointer;
          text-align: left;
          transition: border-color var(--dur-1) var(--ease-out);
        }
        .cp:hover {
          border-color: var(--teal);
        }
        .cp__prefix {
          color: var(--ink-4);
          font-family: var(--font-mono);
        }
        .cp__text {
          flex: 1;
          font-size: var(--text-h3);
          font-weight: 500;
        }
        .cp__action {
          font-family: var(--font-mono);
          font-size: var(--text-caption);
          letter-spacing: var(--tracking-wide);
          text-transform: uppercase;
          color: var(--teal-ink);
        }
      `}</style>
    </button>
  );
}
