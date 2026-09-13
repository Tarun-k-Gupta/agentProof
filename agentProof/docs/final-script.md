# AgentProof — final recording script

One continuous read. **Bold** is a stage direction, everything in `>` is spoken.
Target 3:30: about 3:00 of speech, 20 seconds of deliberate silence on the
expiry beat, 10 seconds of slack.

Boot order, pre-flight checks and mid-take recovery are in `docs/showcase.md`.
Do not start recording until the status rail reads **production** and **x402
on**.

---

## 0:00 – 0:20 · The problem

**Screen:** `/` hero. Still. Do not scroll while talking.

> An AI agent with a wallet is a new kind of security problem. You can't audit
> it, because it decides at runtime. And you can't fully trust it, because
> anything it reads can change its mind — a web page, a tool response, a
> poisoned search result.
>
> So the question isn't "is the model good." It's: when the model is wrong,
> what stops it?

---

## 0:20 – 0:45 · What it is

**Screen:** scroll to the install block. Let `npm i @agentproof/sdk` sit on
screen for a beat before you name it.

> AgentProof is a spending limit the agent can't talk its way around.
>
> It ships two ways: an npm package — `@agentproof/sdk` — and an HTTP API,
> `POST /v1/verify`, for agents that aren't in JavaScript. Three lines in your
> agent: verify the transaction, stop if it isn't allowed. Same verdict from
> both.
>
> And both are advisory by design. The limit itself is enforced on-chain,
> inside the wallet — so it holds even if the agent never calls us.

---

## 0:45 – 1:55 · The demo

**Screen:** `Try it yourself`. This is the film. Click each one and let the
verdict fully land before you speak again.

> The rule here: never more than 100 USDC in one transaction.

**Click "A normal trade" → ALLOW**

> An 80 USDC swap. Inside the limits. Goes through.

**Click "The AI gets tricked" → BLOCK**

> Now a prompt injection. A web page convinces the agent to send funds to a
> stranger. It's a perfectly valid transaction — correctly signed, correctly
> formed. It's refused, because that address isn't on the allowlist.

**Click "The hidden price tag" → BLOCK**

> This one's subtler. A swap that advertises a tiny amount but authorises 250.
> Read the wrong field and it looks cheap. We price it on what it can actually
> spend, not what it claims.

**Click "The AI asks permission" → amber, countdown running**

> And when a trade is big enough that you said you wanted a say, the agent
> stops. This isn't a notification you can miss. The transaction is held open,
> waiting.

**Approve it → ALLOW**

> I can approve it.

**Click it again. Then say nothing. Let the countdown run all the way to zero →
BLOCK.** Twenty seconds of silence is uncomfortable to record and reads as
confidence on playback. The line lands *after* zero, not over it.

> Or I can do nothing. And if nobody answers — it's refused.
>
> Silence is never consent.

---

## 1:55 – 2:20 · The boundary

**Screen:** `/` architecture map. Point at the line down the middle and leave
the cursor there.

> Everything left of this line is advice. Useful, and skippable.
>
> Everything right of it is on-chain, and holds whether or not anyone
> cooperates. The limit lives in an ERC-7579 hook inside the account itself.
>
> The strongest version of that claim isn't something I can click — it's a
> test. It drives the account through a real EntryPoint with no SDK involved
> anywhere, and the account still refuses. We also tried to uninstall the hook
> during development and couldn't: removing it means executing against the
> account, and the hook blocks that too.
>
> The agent can't remove its own guardrails. Neither can we.

---

## 2:20 – 2:50 · Sponsors

**Screen:** `See the receipts`, scrolling slowly enough that the explorer links
are visibly there. Read this verbatim — every clause is calibrated to be
literally true.

> Four protocols, each load-bearing.
>
> **ENS v2** — the agent's limits are published under its own name,
> trader-dot-agentproof-dot-eth. Anyone can check them without asking us.
>
> **The Graph** — a subgraph of what the chain actually admitted, not what was
> intended.
>
> **Hedera** — the API is paid. Every verdict you just watched settled on
> Hedera, logged to a topic we don't control.
>
> **Bazantic** — someone else's gateway calling our check over plain HTTP. No
> verification, no swap.
>
> And the two core limits aren't just tested — they're proven with the SMT
> checker, for every possible input.

---

## 2:50 – 3:05 · Close

**Screen:** back to `/` hero.

> Agents are going to hold money. The only question is whether the limits live
> in a prompt, or somewhere the model can't reach.
>
> AgentProof puts them on-chain. `npm i @agentproof/sdk`.

---

## If you overrun

Cut in this order. Never cut from the demo.

1. The uninstall anecdote at 2:10 (one sentence, saves ~8s)
2. "not what was intended" and "logged to a topic we don't control" from the
   sponsor block (~5s)
3. The second sentence of the close (~4s)

## Five claims that have to stay exact

- **"Proven"** covers `MAX_TRANSFER` and `DAILY_SPEND` over `PolicyLib`. The
  hook is fuzzed and invariant-tested, not proven. Never say "the contract is
  formally verified," and never shorten the SMT line to "the limits are
  proven" — "the two core limits" is what keeps it true.
- **"Advisory by design"** stays attached to the SDK and the API. Drop it and
  the SDK sounds like the product and the hook like plumbing, which is the
  argument backwards.
- **The bypass test is a test.** Say so. Don't let the framing imply the
  browser just demonstrated it.
- **Ledger** is implemented but not on camera, so it isn't in this script. Don't
  add it unless you record a device.
- **Bazantic** runs against the public API over a quick tunnel. If the tunnel is
  down at record time, cut that line rather than claiming it live.
