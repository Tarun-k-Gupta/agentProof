'use client';

import { useState } from 'react';
import { api } from '@/lib/api';

/**
 * Owner sign-in.
 *
 * The token is exchanged once for an HttpOnly, SameSite=Strict session cookie
 * that this code cannot read back. That is the point: the approval control is
 * the only irreversible action on the page, and a token sitting in
 * localStorage is one XSS away from being someone else's.
 */
export function LoginGate({ onSuccess }: { onSuccess: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const result = await api.login(token);
    setBusy(false);
    if (result.ok) {
      setToken('');
      onSuccess();
    } else {
      setError(result.status === 401 ? 'That token was not accepted.' : result.error);
    }
  };

  return (
    <div className="wrap">
      <form onSubmit={submit}>
        <span className="mark" aria-hidden="true" />
        <h1>AgentProof</h1>
        <p>This dashboard can approve spending. Sign in with the owner token.</p>

        <label htmlFor="token">Admin token</label>
        <input
          id="token"
          type="password"
          value={token}
          autoComplete="current-password"
          onChange={(event) => setToken(event.target.value)}
          placeholder="AGENTPROOF_ADMIN_TOKEN"
          required
        />

        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}

        <button type="submit" disabled={busy || token.length === 0}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="note">
          Viewing decisions and approving them are separate permissions. This grants both; agent processes publish with
          a header token and can do neither.
        </p>
      </form>

      <style jsx>{`
        .wrap { display: grid; place-items: center; height: 100dvh; padding: 24px; background: var(--bg-2); }
        form {
          width: min(380px, 100%);
          background: var(--bg);
          border: 1px solid var(--line);
          border-radius: var(--radius);
          box-shadow: var(--shadow-2);
          padding: 28px 26px 22px;
          display: flex;
          flex-direction: column;
        }
        .mark { width: 12px; height: 12px; border-radius: 4px; background: var(--teal); box-shadow: 0 0 0 4px var(--teal-bg); }
        h1 { font-size: 18px; font-weight: 700; margin-top: 14px; }
        form > p { font-size: 13px; color: var(--ink-3); margin-top: 6px; }
        label {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--ink-4);
          margin-top: 20px;
          margin-bottom: 6px;
        }
        input {
          min-height: 44px;
          padding: 0 12px;
          border: 1px solid var(--line-2);
          border-radius: var(--radius-sm);
          background: var(--bg);
          color: var(--ink);
          font: inherit;
          font-family: var(--mono);
          font-size: 13px;
        }
        input:focus { border-color: var(--teal); }
        .error { color: var(--red); font-size: 12.5px; margin-top: 10px; }
        button {
          min-height: 44px;
          margin-top: 16px;
          border-radius: var(--radius-sm);
          border: 1px solid var(--teal);
          background: var(--teal);
          color: #fff;
          font-weight: 650;
          font-size: 13.5px;
          cursor: pointer;
        }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        .note { font-size: 11.5px; color: var(--ink-4); margin-top: 18px; border-top: 1px solid var(--line); padding-top: 14px; }
      `}</style>
    </div>
  );
}
