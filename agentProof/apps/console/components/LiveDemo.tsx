'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address, Hex } from '@agentproof/sdk';
import {
  encodeErc20Transfer,
  encodeSwapExactIn,
  encodeErc20Approve,
  UNLIMITED_APPROVAL,
} from '@agentproof/sdk/calldata';
import type { Verdict } from '@/lib/types';
import { api } from '@/lib/api';

/**
 * The thirty-second explanation, with no reading required.
 *
 * A judge with five minutes will not read an essay, so this plays itself: a
 * request enters on the left, moves through four stages, and lands on a verdict.
 * The words on screen are the numbers and the outcome — everything else is
 * position, colour and motion.
 *
 * Verdicts come from the real API when it is reachable. The expected outcome is
 * also known up front, so a cold API degrades to the same animation rather than
 * to a broken-looking page.
 */

const WETH = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14' as Address;
const ATTACKER = '0x000000000000000000000000000000000000dead' as Address;

type Kind = 'swap' | 'transfer' | 'approve';

interface Scene {
  id: string;
  /** Shown as the agent's request. Kept to a fragment, not a sentence. */
  ask: string;
  amount: string;
  kind: Kind;
  to?: string;
  /** Rendered under the verdict. Two or three words. */
  because: string;
  expect: 'ALLOW' | 'BLOCK' | 'REQUIRE_APPROVAL';
}

const SCENES: Scene[] = [
  { id: 'ok', ask: 'Swap 80 USDC', amount: '80', kind: 'swap', because: 'within limits', expect: 'ALLOW' },
  { id: 'big', ask: 'Swap 250 USDC', amount: '250', kind: 'swap', because: 'over the 100 limit', expect: 'BLOCK' },
  {
    id: 'ask',
    ask: 'Swap 100 USDC',
    amount: '100',
    kind: 'swap',
    because: 'you asked to approve this size',
    expect: 'REQUIRE_APPROVAL',
  },
  {
    id: 'inject',
    ask: 'Send 50 USDC to 0x…dead',
    amount: '50',
    kind: 'transfer',
    to: ATTACKER,
    because: 'unknown recipient',
    expect: 'BLOCK',
  },
  {
    id: 'approve',
    ask: 'Approve unlimited spending',
    amount: '0',
    kind: 'approve',
    because: 'unbounded outflow',
    expect: 'BLOCK',
  },
];

const STEPS = ['Agent', 'Read it', 'Check it', 'Enforce'] as const;

const STEP_MS = 820;
const HOLD_MS = 2600;

const FALLBACK = {
  asset: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
  router: '0x3a9d48ab9751398bbfa63ad67599bb04e4bdf98b',
  account: '0x00000000000000000000000000000000000000a1',
  agent: 'trader.agentproof.eth',
};

function baseUnits(amount: string): bigint {
  const [whole = '0', frac = ''] = amount.split('.');
  return BigInt(whole || '0') * 1_000_000n + BigInt((frac + '000000').slice(0, 6) || '0');
}

export function LiveDemo() {
  const [sceneIndex, setSceneIndex] = useState(0);
  const [step, setStep] = useState(0);
  const [verdict, setVerdict] = useState<Verdict>();
  const [paused, setPaused] = useState(false);
  const [addrs, setAddrs] = useState(FALLBACK);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  const scene = SCENES[sceneIndex];

  useEffect(() => {
    void (async () => {
      const result = await api.health();
      if (!result.ok) return;
      setAddrs((previous) => ({ ...previous, account: result.value.account, agent: result.value.agent }));
      const policy = await api.policy(result.value.agent);
      if (policy.ok) {
        const doc = (policy.value.policy as any)?.document ?? policy.value.policy;
        if (doc?.asset?.address) {
          setAddrs((previous) => ({
            ...previous,
            asset: doc.asset.address,
            router: doc.policies?.allowedContracts?.[0] ?? previous.router,
            // Swap output goes to an address the policy allowlists. The
            // protected account is not itself on that list, and sending there
            // makes every scenario fail for the same uninteresting reason.
            account: doc.policies?.allowedRecipients?.[0] ?? previous.account,
          }));
        }
      }
    })();
  }, []);

  const build = useCallback(
    (current: Scene): { to: string; data: Hex } => {
      const units = baseUnits(current.amount);
      if (current.kind === 'swap') {
        return {
          to: addrs.router,
          data: encodeSwapExactIn({
            recipient: addrs.account as Address,
            amountIn: units,
            tokenIn: addrs.asset as Address,
            tokenOut: WETH,
          }),
        };
      }
      if (current.kind === 'transfer') {
        return { to: addrs.asset, data: encodeErc20Transfer((current.to ?? ATTACKER) as Address, units) };
      }
      return { to: addrs.asset, data: encodeErc20Approve(addrs.router as Address, UNLIMITED_APPROVAL) };
    },
    [addrs],
  );

  // One pass: advance the stage lights, ask the real API while they run, reveal,
  // hold, then move to the next scene.
  useEffect(() => {
    if (paused) return;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setStep(0);
    setVerdict(undefined);

    const action = build(scene);
    void fetch('/api/v1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ agent: addrs.agent, action: { ...action, value: '0', chainId: 11155111 } }),
    })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body) => setVerdict(body))
      .catch(() => undefined);

    for (let i = 1; i <= STEPS.length; i += 1) {
      timers.current.push(setTimeout(() => setStep(i), STEP_MS * i));
    }
    timers.current.push(
      setTimeout(
        () => setSceneIndex((previous) => (previous + 1) % SCENES.length),
        STEP_MS * STEPS.length + HOLD_MS,
      ),
    );

    return () => timers.current.forEach(clearTimeout);
  }, [sceneIndex, paused, build, scene, addrs.agent]);

  const decision = verdict?.decision ?? scene.expect;
  const settled = step >= STEPS.length;
  const tone = decision === 'ALLOW' ? 'allow' : decision === 'REQUIRE_APPROVAL' ? 'ask' : 'block';
  const outcome = decision === 'ALLOW' ? 'Allowed' : decision === 'REQUIRE_APPROVAL' ? 'Needs you' : 'Stopped';
  const mark = decision === 'ALLOW' ? '✓' : decision === 'REQUIRE_APPROVAL' ? '!' : '✕';

  return (
    <figure
      className="demo"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      aria-label={`Demonstration: ${scene.ask} results in ${decision}`}
    >
      <figcaption className="demo__cap">
        <span className="demo__live">
          <span className="demo__pulse" aria-hidden="true" />
          {verdict ? 'Live policy engine' : 'Policy engine'}
        </span>
        <span className="demo__hint">hover to pause</span>
      </figcaption>

      <div className="demo__stage">
        <div className="demo__ask" key={scene.id}>
          <span className="demo__ask-label">The AI wants to</span>
          <span className="demo__ask-text">{scene.ask}</span>
        </div>

        <ol className="demo__pipe">
          {STEPS.map((label, index) => {
            const state = step > index ? 'done' : step === index ? 'active' : 'idle';
            const isLast = index === STEPS.length - 1;
            return (
              <li key={label} className={`pipe ${isLast ? 'pipe--hard' : ''}`}>
                <span
                  className={`pipe__dot pipe__dot--${state} ${
                    isLast && settled && tone !== 'allow' ? `pipe__dot--${tone}` : ''
                  }`}
                >
                  {isLast && settled ? mark : state === 'done' ? '✓' : ''}
                </span>
                <span className="pipe__label">{label}</span>
                {!isLast ? <span className={`pipe__wire ${step > index ? 'pipe__wire--on' : ''}`} /> : null}
              </li>
            );
          })}
        </ol>

        <div className={`demo__out demo__out--${settled ? tone : 'wait'}`}>
          {settled ? (
            <>
              <span className="demo__verdict">{outcome}</span>
              <span className="demo__why">{scene.because}</span>
            </>
          ) : (
            <span className="demo__verdict demo__verdict--wait">…</span>
          )}
        </div>
      </div>

      <div className="demo__ticks" role="tablist" aria-label="Choose a scenario">
        {SCENES.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={index === sceneIndex}
            className={`tick ${index === sceneIndex ? 'tick--on' : ''}`}
            onClick={() => setSceneIndex(index)}
          >
            <span className="sr-only">{item.ask}</span>
          </button>
        ))}
      </div>

      <style jsx>{`
        .demo {
          border: 1px solid var(--line);
          border-radius: var(--radius-lg);
          background:
            radial-gradient(90% 140% at 82% -20%, var(--teal-bg) 0%, transparent 55%),
            var(--card);
          padding: 18px 22px 20px;
          box-shadow: var(--shadow-2);
          display: flex;
          flex-direction: column;
          gap: 18px;
        }
        .demo__cap {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          font-size: var(--text-caption);
          color: var(--ink-4);
        }
        .demo__live {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          font-family: var(--font-mono);
          letter-spacing: var(--tracking-wide);
          text-transform: uppercase;
          color: var(--teal-ink);
        }
        .demo__pulse {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--teal);
          animation: dpulse 2s var(--ease-out) infinite;
        }
        .demo__hint {
          font-family: var(--font-mono);
        }

        .demo__stage {
          display: grid;
          grid-template-columns: minmax(180px, 0.9fr) minmax(280px, 1.5fr) minmax(150px, 0.7fr);
          gap: 26px;
          align-items: center;
        }
        @media (max-width: 860px) {
          .demo__stage {
            grid-template-columns: 1fr;
            gap: 18px;
          }
        }

        .demo__ask {
          display: flex;
          flex-direction: column;
          gap: 4px;
          animation: rise var(--dur-2) var(--ease-out);
        }
        .demo__ask-label {
          font-size: var(--text-caption);
          color: var(--ink-4);
        }
        .demo__ask-text {
          font-family: var(--font-display);
          font-size: clamp(19px, 1.9vw, 27px);
          font-weight: 700;
          letter-spacing: var(--tracking-tight);
          line-height: 1.15;
        }

        .demo__pipe {
          display: flex;
          align-items: flex-start;
          list-style: none;
          justify-content: space-between;
        }
        .pipe {
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          flex: 1;
        }
        .pipe__dot {
          width: 30px;
          height: 30px;
          border-radius: 50%;
          border: 2px solid var(--line-2);
          background: var(--bg);
          display: grid;
          place-items: center;
          font-size: 13px;
          font-weight: 700;
          color: var(--card);
          z-index: 2;
          transition:
            background var(--dur-2) var(--ease-out),
            border-color var(--dur-2) var(--ease-out),
            transform var(--dur-2) var(--ease-spring);
        }
        .pipe__dot--active {
          border-color: var(--teal);
          background: var(--teal-bg);
          transform: scale(1.18);
        }
        .pipe__dot--done {
          border-color: var(--teal);
          background: var(--teal);
        }
        .pipe__dot--block {
          border-color: var(--red);
          background: var(--red);
        }
        .pipe__dot--ask {
          border-color: var(--amber);
          background: var(--amber);
        }
        .pipe__label {
          font-size: var(--text-caption);
          color: var(--ink-3);
          white-space: nowrap;
        }
        .pipe--hard .pipe__label {
          color: var(--ink);
          font-weight: 600;
        }
        .pipe__wire {
          position: absolute;
          top: 14px;
          left: calc(50% + 18px);
          right: calc(-50% + 18px);
          height: 2px;
          background: var(--line-2);
          z-index: 1;
          overflow: hidden;
        }
        .pipe__wire::after {
          content: '';
          position: absolute;
          inset: 0;
          background: var(--teal);
          transform: scaleX(0);
          transform-origin: left;
          transition: transform var(--dur-2) var(--ease-out);
        }
        .pipe__wire--on::after {
          transform: scaleX(1);
        }

        .demo__out {
          border-radius: var(--radius);
          padding: 14px 16px;
          display: flex;
          flex-direction: column;
          gap: 2px;
          border: 1px solid var(--line);
          min-height: 72px;
          justify-content: center;
          transition: background var(--dur-2) var(--ease-out), border-color var(--dur-2) var(--ease-out);
        }
        .demo__out--allow {
          background: var(--teal-bg);
          border-color: var(--teal-line);
        }
        .demo__out--block {
          background: var(--red-bg);
          border-color: var(--red-line);
        }
        .demo__out--ask {
          background: var(--amber-bg);
          border-color: var(--amber-line);
        }
        .demo__verdict {
          font-family: var(--font-display);
          font-size: clamp(21px, 2.1vw, 30px);
          font-weight: 800;
          letter-spacing: var(--tracking-tight);
          line-height: 1.05;
        }
        .demo__out--allow .demo__verdict {
          color: var(--teal-ink);
        }
        .demo__out--block .demo__verdict {
          color: var(--red);
        }
        .demo__out--ask .demo__verdict {
          color: var(--amber);
        }
        .demo__verdict--wait {
          color: var(--ink-4);
        }
        .demo__why {
          font-size: var(--text-small);
          color: var(--ink-2);
        }

        .demo__ticks {
          display: flex;
          gap: 6px;
        }
        .tick {
          height: 4px;
          flex: 1;
          border: 0;
          padding: 0;
          border-radius: 2px;
          background: var(--line-2);
          cursor: pointer;
          transition: background var(--dur-1) var(--ease-out);
        }
        .tick--on {
          background: var(--teal);
        }

        @keyframes dpulse {
          0% { box-shadow: 0 0 0 0 rgba(67, 207, 184, 0.55); }
          70% { box-shadow: 0 0 0 6px rgba(67, 207, 184, 0); }
          100% { box-shadow: 0 0 0 0 rgba(67, 207, 184, 0); }
        }
        @keyframes rise {
          from { opacity: 0; transform: translateY(6px); }
        }
        @media (prefers-reduced-motion: reduce) {
          .demo__pulse,
          .demo__ask { animation: none; }
          .pipe__dot,
          .pipe__wire::after { transition: none; }
        }
      `}</style>
    </figure>
  );
}
