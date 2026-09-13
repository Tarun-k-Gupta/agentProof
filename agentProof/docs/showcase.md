# Showcase — recording run sheet

`docs/demo-script.md` is the narration, beat by beat. This is everything around
it: what to boot, in what order, what must be true on screen before you hit
record, and the sponsor story compressed to the length it actually gets.

Target: **3:30**. Budget 3:00 of content and 30 seconds of slack, because the
approval-expiry beat runs on a real clock and will not hurry for you.

---

## 1. Boot order

Four terminals. The order matters — each one checks the one before it.

```bash
# 1 — API. Production mode, payment gate on, owner key deliberately absent.
set -a; source .env; set +a
unset OWNER_PRIVATE_KEY DEPLOYER_PRIVATE_KEY
AGENTPROOF_APPROVAL_TIMEOUT_MS=20000 pnpm api
```

The API refuses to boot in production mode if a deployed address is missing or
if the x402 facilitator does not advertise `hedera-testnet` with `scheme=exact`.
That refusal is a feature here: if it started, the chain of claims behind it
holds.

```bash
# 2 — public hostname for the API (needed only for the Bazantic beat)
bash scripts/tunnel.sh
```

Rewrites `API_PUBLIC_URL` in `.env` and the README table to the fresh hostname,
then holds the tunnel open. Quick tunnels get a new hostname on every start, so
run this *after* the API and *before* the console.

```bash
# 3 — console
pnpm console          # :3000
```

```bash
# 4 — spare, for the Bazantic beat
pnpm recipe:verify-before-you-swap
```

## 2. Pre-flight — check all six before recording

1. Status rail reads **production** and **x402 on**. If it reads development,
   the verdicts are real but the payment story is not.
2. `/health` shows `MAX_TRANSFER` and `DAILY_SPEND` as **PROVEN**. `NOT_RUN`
   means the proof artifacts are missing — `pnpm verify:formal` regenerates
   them, and it is not a two-minute job, so check this early.
3. One throwaway verify click, then reload. The first x402 settlement is
   noticeably slower than the rest and you do not want that on tape.
4. The Integrations panel shows the public API link — proof the tunnel is
   actually wired through, not just open.
5. Explorer tabs pre-opened on the hook and the smart account. Loading
   Etherscan live costs you fifteen seconds of dead air.
6. Screen at a resolution where the verdict chips are legible. The BLOCK reason
   text is the substance of the whole demo and it is the first thing to go
   unreadable when scaled down.

## 3. The 3:30 shape

| Time | Beat | What is on screen |
|---|---|---|
| 0:00–0:20 | The problem | `/` hero |
| 0:20–0:45 | What it is | install block + snippet |
| 0:45–1:55 | **The demo** — allow, injection, hidden price tag, approve, expire | `Try it yourself` |
| 1:55–2:20 | The boundary | architecture map |
| 2:20–2:55 | Sponsors | `See the receipts` |
| 2:55–3:10 | Close | back to hero |

The middle 70 seconds is the film. Everything else is framing. If you overrun,
cut from section 2 and the close — never from the four verdicts.

Narration for each beat is in `docs/demo-script.md`. Two directions that are
easy to get wrong:

**The expiry beat.** Click the escalated action a second time and then *say
nothing*. Twenty seconds of silence feels unbearable while recording and reads
as confidence on playback. The line lands after the countdown hits zero, not
over it: "Silence is never consent."

**The bypass claim.** The demo shows the SDK refusing things. The strongest
claim is about the case where the SDK is not involved at all, and that is a
test, not a click: `test_RejectsUserOpThatBypassesTheSdkEntirely` in
`contracts/test/integration/RealAccount.t.sol`. Say it is a test. Do not imply
the browser just demonstrated it.

## 4. Sponsors — 35 seconds, seven claims

Scroll `See the receipts` slowly enough that the explorer links are visibly
there. The point being made is not "we used these"; it is "every one of these is
deployed and you can check it without us." Every address is in the README's
[Deployed addresses and live links](../README.md#deployed-addresses-and-live-links)
section.

**Uniswap v4** — Universal Router calldata decoded to worst-case outflow per
currency. Exact-output binds on `amountInMaximum`, never the quote. Pinned
against six real Sepolia transactions; the first run decoded all six as
`UNBOUNDED`, which is how we found an off-by-one in the action bytes that
self-encoded fixtures had hidden.

**ENSv2** — the agent's limits are published under its own name,
`trader.agentproof.eth`, as `agentproof.policy`, `.hook` and `.status`. Roles
are split down to the individual record: the owner can repoint policy, the agent
key can only suspend itself. There are two transactions on Sepolia showing a
policy being repointed and restored.

**The Graph** — a subgraph of the hook's own events, so the spend figure is what
the chain *admitted*, not what was intended. Disagreement with a direct on-chain
read reports `reconciled:false` rather than picking a winner.

**Hedera** — the API is x402-gated. Every verdict in the demo was paid for, and
every settlement is written to an HCS topic we do not control. Two real
settlements are recorded.

**Bazantic** — a gateway recipe chaining quote → decode → verify →
execute-or-stop over plain HTTP, importing nothing internal. Failing to *obtain*
a verification stops the swap exactly like a BLOCK does.

**ERC-7579 / ERC-4337** — where the limit physically lives. An ERC-7579 module
on an MSAAdvanced account through EntryPoint v0.8.0.

**Ledger and the SMT checker** — hardware approval for the human-in-the-loop
path, and the two core limits proven for all inputs rather than for the cases a
test happened to pick.

If you are short on time, cut Ledger and Bazantic from the spoken list. Do not
cut Hedera or the hook — they are the two that carry the thesis.

## 5. Claims to keep precise

These are the ones where an imprecise sentence would be a false one.

- **"Proven"** covers `MAX_TRANSFER` and `DAILY_SPEND` over `PolicyLib`. The
  hook itself is fuzzed and invariant-tested. Never say "the contract is
  formally verified."
- **Ledger** is implemented, not on camera. Do not imply a device is in the
  room unless you record one.
- **The public API is a quick tunnel.** If it is down at record time, cut the
  Bazantic beat rather than claiming it live.
- **"Can't be bypassed"** needs its qualifier every time: the hook is the
  boundary, the SDK and API are advisory. The entire design rests on saying
  which is which, so slipping here undoes the argument.
- The account holds roughly 154 USDC against a 100 per-transaction limit and a
  10 reserve. Real, funded from the owner EOA.

## 6. If something breaks mid-take

**Verdicts hang.** The facilitator is unreachable. The API forwards unpaid
rather than hanging, so verdicts still land — but stop claiming payment is live
in that take.

**Console shows API unreachable.** The tunnel rotated or the API died. The
console proxies `/api/v1/*` to `AGENTPROOF_API_URL`, resolved at build time —
locally that is `next dev` reading `.env`, so restart the console after
`scripts/tunnel.sh` rewrites it.

**A verdict disagrees with the narration.** Stop and keep the real verdict. The
policy is in `agent.policy.json` and the limits are on-chain; if the demo
disagrees with the script, the script is what is wrong.
