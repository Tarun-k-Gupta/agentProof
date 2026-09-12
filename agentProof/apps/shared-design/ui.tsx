'use client';

import { useCallback, useEffect, useState } from 'react';

/* Shared AgentProof UI primitives. Logic-free presentation over API data. */

export function short(addr: string): string {
  return typeof addr === 'string' && addr.length > 14 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

export function DecisionChip({ decision }: { decision?: string }) {
  const tone = decision === 'ALLOW' ? 'allow' : decision === 'BLOCK' ? 'block' : 'approval';
  return <span className={`ap-chip ap-chip--${tone}`}>{decision ?? '—'}</span>;
}

export function ProofSeal({ property, status }: { property: string; status: string }) {
  if (status !== 'PROVEN') return null;
  return (
    <span className="ap-seal" title={`${property} formally verified`}>
      ◆ {property} · PROVEN
    </span>
  );
}

export function Amount({ baseUnits, decimals = 6, asset = 'USDC' }: { baseUnits: string | bigint; decimals?: number; asset?: string }) {
  let display = '—';
  try {
    const v = BigInt(baseUnits);
    const whole = v / 10n ** BigInt(decimals);
    const frac = (v % 10n ** BigInt(decimals)).toString().padStart(decimals, '0').slice(0, 2);
    display = `${whole.toLocaleString('en-US')}.${frac}`;
  } catch {
    display = String(baseUnits);
  }
  return (
    <span className="ap-amount">
      {display}
      <span className="ap-amount__unit">{asset}</span>
    </span>
  );
}

export function AddrChip({ address, explorer }: { address: string; explorer?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable — the address itself is still visible */
    }
  }, [address]);
  return (
    <span className="ap-addr">
      {short(address)}
      <button type="button" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
      {explorer ? (
        <a href={explorer} target="_blank" rel="noreferrer noopener">
          Explorer ↗
        </a>
      ) : null}
    </span>
  );
}

export function PolicyRow({
  name,
  passed,
  observed,
  limit,
}: {
  name: string;
  passed: boolean;
  observed?: string;
  limit?: string;
}) {
  // Bar proportion from raw magnitudes; falls back to binary when unparseable.
  let ratio: number | null = null;
  try {
    const o = observed !== undefined ? BigInt(observed) : null;
    const l = limit !== undefined ? BigInt(limit) : null;
    if (o !== null && l !== null && l > 0n) {
      ratio = Math.min(1, Number((o * 1000n) / l) / 1000);
    }
  } catch {
    ratio = null;
  }
  return (
    <div className="ap-policy-row">
      <span className="ap-policy-row__name">
        <span className={`ap-policy-row__mark ap-policy-row__mark--${passed ? 'pass' : 'fail'}`}>
          {passed ? '✓' : '✕'}
        </span>
        {name}
      </span>
      <span className="ap-policy-row__bar" role="img" aria-label={`${name}: observed ${observed ?? '—'} of limit ${limit ?? '—'}`}>
        <span
          className={`ap-policy-row__fill ${!passed ? 'ap-policy-row__fill--over' : ''}`}
          style={{ width: `${Math.round((ratio ?? (passed ? 0.12 : 1)) * 100)}%` }}
        />
      </span>
      <span className="ap-policy-row__nums">
        {observed ?? '—'} / {limit ?? '—'}
      </span>
    </div>
  );
}

export function SpendRing({
  spent,
  limit,
  size = 120,
}: {
  spent: bigint | string;
  limit: bigint | string;
  size?: number;
}) {
  let ratio = 0;
  try {
    const s = BigInt(spent);
    const l = BigInt(limit);
    ratio = l > 0n ? Math.min(1, Number((s * 1000n) / l) / 1000) : 0;
  } catch {
    ratio = 0;
  }
  const r = (size - 16) / 2;
  const c = 2 * Math.PI * r;
  const gid = `apg-${size}`;
  return (
    <span className="ap-ring">
      <svg className="ap-ring__svg" width={size} height={size} role="img" aria-label={`spent ${Math.round(ratio * 100)} percent of limit`}>
        <defs>
          <linearGradient id={gid} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="var(--teal-strong)" />
            <stop offset="100%" stopColor="var(--teal-glow)" />
          </linearGradient>
        </defs>
        <circle className="ap-ring__track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={10} />
        <circle
          className="ap-ring__value"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`url(#${gid})`}
          strokeWidth={10}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - ratio)}
        />
      </svg>
      <span className="ap-ring__center ap-tabular">{Math.round(ratio * 100)}%</span>
    </span>
  );
}

export function useTheme(): { theme: 'light' | 'dark'; toggle: () => void } {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  useEffect(() => {
    const stored = window.localStorage.getItem('agentproof-theme');
    const initial =
      stored === 'light' || stored === 'dark'
        ? stored
        : window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
    setTheme(initial);
    document.documentElement.dataset.theme = initial;
  }, []);
  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      window.localStorage.setItem('agentproof-theme', next);
      return next;
    });
  }, []);
  return { theme, toggle };
}

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button type="button" className="ap-theme-toggle" onClick={toggle} aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}>
      {theme === 'light' ? '☾ Dark' : '☀ Light'}
    </button>
  );
}
