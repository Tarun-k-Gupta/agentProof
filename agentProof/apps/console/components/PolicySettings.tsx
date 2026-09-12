'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { PolicyLimits, PolicyPatch, PolicyUpdateResult } from '@/lib/types';
import { isAddress, parseAddressList, toBaseUnits, toDisplay } from '@/lib/usdc';

/**
 * Policy settings drawer.
 *
 * The developer-facing alternative to hand-editing agent.policy.json. It does
 * not reimplement policy validation: the server runs the submitted values
 * through the same `resolvePolicy` every other entry point does, so a bad
 * submission (daily spend under the per-transaction limit, an empty
 * allowlist) comes back with the same refusal a malformed file would get at
 * startup — surfaced here rather than swallowed.
 *
 * It also does not pretend the edit is the whole story. Saving updates the
 * running server and, when a policy path is known, the file on disk — but the
 * three-way binding this whole project is built around means an edit here can
 * leave ENS and the on-chain hook still publishing the old hash. That is
 * reported, not hidden.
 */

interface FormState {
  maxTransaction: string;
  dailySpend: string;
  approvalThreshold: string;
  minBalance: string;
  allowedContracts: string;
  allowedRecipients: string;
}

const EMPTY: FormState = {
  maxTransaction: '',
  dailySpend: '',
  approvalThreshold: '',
  minBalance: '',
  allowedContracts: '',
  allowedRecipients: '',
};

function fromLimits(limits: PolicyLimits): FormState {
  return {
    maxTransaction: toDisplay(limits.maxTransaction),
    dailySpend: toDisplay(limits.dailySpend),
    approvalThreshold: toDisplay(limits.approvalThreshold),
    minBalance: toDisplay(limits.minBalance),
    allowedContracts: limits.allowedContracts.join('\n'),
    allowedRecipients: limits.allowedRecipients.join('\n'),
  };
}

/**
 * GET /v1/policy/:name returns the raw document when no ENS resolver is
 * configured, or an ENS-resolution wrapper with `.document` inside when one
 * is — see routes/policyRoute. Both are handled rather than assumed.
 */
function extractLimits(policy: unknown): PolicyLimits | undefined {
  if (typeof policy !== 'object' || policy === null) return undefined;
  const withDocument = policy as { document?: { policies?: PolicyLimits } };
  const direct = policy as { policies?: PolicyLimits };
  return withDocument.document?.policies ?? direct.policies;
}

export function PolicySettings({ open, onClose, agent }: { open: boolean; onClose: () => void; agent?: string }) {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<PolicyUpdateResult>();

  useEffect(() => {
    if (!open || !agent) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(undefined);
    setSaveError(undefined);
    setSaved(undefined);

    void api.policy(agent).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setLoadError(result.error);
        return;
      }
      const limits = extractLimits(result.value.policy);
      if (!limits) {
        setLoadError('The API response had no policies block to read.');
        return;
      }
      setForm(fromLimits(limits));
    });

    return () => {
      cancelled = true;
    };
  }, [open, agent]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const field = (key: keyof FormState) => ({
    value: form[key],
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setForm((previous) => ({ ...previous, [key]: event.target.value }));
      setSaveError(undefined);
      setSaved(undefined);
    },
  });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaveError(undefined);
    setSaved(undefined);

    let patch: PolicyPatch;
    try {
      patch = {
        maxTransaction: toBaseUnits(form.maxTransaction),
        dailySpend: toBaseUnits(form.dailySpend),
        approvalThreshold: toBaseUnits(form.approvalThreshold),
        minBalance: toBaseUnits(form.minBalance),
        allowedContracts: requireAddresses(form.allowedContracts, 'Allowed contracts'),
        allowedRecipients: requireAddresses(form.allowedRecipients, 'Allowed recipients'),
      };
    } catch (error) {
      setSaving(false);
      setSaveError(error instanceof Error ? error.message : String(error));
      return;
    }

    const result = await api.updatePolicy(patch);
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.error);
      return;
    }
    setSaved(result.value);
    setForm(fromLimits(result.value.policy));
  };

  return (
    <div className="scrim" onClick={onClose} role="presentation">
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Policy settings"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2>Policy limits</h2>
            <p>Amounts in USDC. Saving runs the same validation a hand-edited agent.policy.json goes through.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close policy settings">
            ✕
          </button>
        </header>

        <form className="body" onSubmit={submit}>
          {loading ? <p className="muted">Loading the current policy…</p> : null}
          {loadError ? <p className="error">Could not load the current policy: {loadError}</p> : null}

          <div className="grid">
            <NumberField label="Max transaction" hint="per action, USDC" {...field('maxTransaction')} />
            <NumberField label="Daily spend" hint="rolling UTC day, USDC" {...field('dailySpend')} />
            <NumberField label="Approval threshold" hint="≥ this needs a human" {...field('approvalThreshold')} />
            <NumberField label="Minimum balance" hint="reserve never spent" {...field('minBalance')} />
          </div>

          <details className="advanced">
            <summary>Advanced — allowlists</summary>
            <label htmlFor="policy-contracts">Allowed contracts, one address per line</label>
            <textarea
              id="policy-contracts"
              rows={3}
              spellCheck={false}
              className="mono"
              {...field('allowedContracts')}
            />
            <label htmlFor="policy-recipients">Allowed recipients, one address per line</label>
            <textarea
              id="policy-recipients"
              rows={3}
              spellCheck={false}
              className="mono"
              {...field('allowedRecipients')}
            />
          </details>

          {saveError ? (
            <p className="error" role="alert">
              {saveError}
            </p>
          ) : null}

          {saved ? (
            <div className="saved" role="status">
              <p className="hash mono">policyHash {saved.policyHash}</p>
              <p className={saved.persisted ? 'ok' : 'warn'}>
                {saved.persisted
                  ? `Written to ${saved.policyPath}.`
                  : 'Not written to disk — no AGENTPROOF_POLICY path is configured on the server, so this only ' +
                    'changed the running process. A restart reverts to the file.'}
              </p>
              {saved.ens === null ? (
                <p className="note">No ENS resolver is configured for this session, so there is nothing to compare against.</p>
              ) : saved.ens.matchesLocal ? (
                <p className="ok">ENS still agrees with the local policy.</p>
              ) : (
                <p className="warn">
                  ENS still publishes a different hash. An agent bound to this policy will refuse to start until the{' '}
                  <code>agentproof.policy</code> text record is updated to match.
                </p>
              )}
            </div>
          ) : null}

          <button type="submit" disabled={saving || loading}>
            {saving ? 'Saving…' : 'Save limits'}
          </button>
        </form>
      </aside>

      <style jsx>{`
        .scrim {
          position: fixed;
          inset: 0;
          background: rgba(11, 18, 32, 0.42);
          display: flex;
          justify-content: flex-end;
          z-index: 40;
          animation: fade 160ms ease-out;
        }
        .drawer {
          width: min(480px, 100%);
          height: 100%;
          background: var(--bg);
          border-left: 1px solid var(--line);
          box-shadow: var(--shadow-2);
          display: flex;
          flex-direction: column;
          animation: slide 220ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        header {
          display: flex;
          gap: 16px;
          align-items: flex-start;
          justify-content: space-between;
          padding: 20px 22px 16px;
          border-bottom: 1px solid var(--line);
        }
        h2 { font-size: 15px; font-weight: 650; }
        header p { font-size: 12.5px; color: var(--ink-3); margin-top: 4px; max-width: 40ch; }
        header button {
          min-width: 44px;
          min-height: 44px;
          border: 1px solid var(--line);
          background: var(--bg-2);
          border-radius: var(--radius-sm);
          cursor: pointer;
          color: var(--ink-3);
        }
        header button:hover { background: var(--bg-3); color: var(--ink); }
        .body { padding: 18px 22px 26px; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
        @media (max-width: 420px) { .grid { grid-template-columns: 1fr; } }
        .muted { color: var(--ink-4); font-size: 13px; }
        .error { color: var(--red); font-size: 12.5px; }
        .advanced {
          border-top: 1px solid var(--line);
          padding-top: 14px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .advanced summary {
          cursor: pointer;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--ink-4);
        }
        .advanced label {
          font-size: 11.5px;
          color: var(--ink-3);
          margin-top: 6px;
        }
        .advanced textarea {
          width: 100%;
          margin-top: 4px;
          padding: 8px 10px;
          border: 1px solid var(--line-2);
          border-radius: var(--radius-sm);
          background: var(--bg);
          color: var(--ink);
          font-size: 12px;
          resize: vertical;
        }
        .advanced textarea:focus { border-color: var(--teal); }
        .saved {
          border: 1px solid var(--line);
          border-radius: var(--radius);
          background: var(--bg-2);
          padding: 12px 14px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .hash { font-size: 11.5px; color: var(--ink-2); word-break: break-all; }
        .ok { color: var(--teal-ink); font-size: 12.5px; }
        .warn { color: var(--amber); font-size: 12.5px; }
        .note { color: var(--ink-4); font-size: 12.5px; }
        code { font-family: var(--mono); font-size: 0.92em; background: var(--bg-3); padding: 1px 4px; border-radius: 4px; }
        button[type='submit'] {
          min-height: 44px;
          border-radius: var(--radius-sm);
          border: 1px solid var(--teal);
          background: var(--teal);
          color: #fff;
          font-weight: 650;
          font-size: 13.5px;
          cursor: pointer;
        }
        button[type='submit']:disabled { opacity: 0.5; cursor: not-allowed; }
        @keyframes fade { from { opacity: 0; } }
        @keyframes slide { from { transform: translateX(24px); opacity: 0; } }
      `}</style>
    </div>
  );
}

function NumberField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      <div className="wrap">
        <input type="text" inputMode="decimal" value={value} onChange={onChange} placeholder="0.00" required />
        <span className="suffix">USDC</span>
      </div>
      <span className="hint">{hint}</span>
      <style jsx>{`
        .field { display: flex; flex-direction: column; gap: 5px; }
        .label { font-size: 12px; font-weight: 600; color: var(--ink-2); }
        .wrap {
          display: flex;
          align-items: center;
          border: 1px solid var(--line-2);
          border-radius: var(--radius-sm);
          background: var(--bg);
          overflow: hidden;
        }
        .wrap:focus-within { border-color: var(--teal); }
        input {
          min-height: 40px;
          flex: 1 1 auto;
          min-width: 0;
          border: 0;
          padding: 0 10px;
          background: transparent;
          color: var(--ink);
          font: inherit;
          font-variant-numeric: tabular-nums;
        }
        input:focus { outline: none; }
        .suffix { font-size: 11px; color: var(--ink-4); padding-right: 10px; }
        .hint { font-size: 11px; color: var(--ink-4); }
      `}</style>
    </label>
  );
}

function requireAddresses(text: string, label: string): string[] {
  const list = parseAddressList(text);
  const bad = list.find((entry) => !isAddress(entry));
  if (bad) throw new Error(`${label}: "${bad}" is not a 20-byte address`);
  return list;
}
