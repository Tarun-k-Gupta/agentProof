# AgentProof — 3-minute demo script

Recording setup (do this first):

```bash
# API: production, payment gate on, owner key excluded (it refuses to boot otherwise).
# The shortened approval deadline is so the expiry beat fits the video.
set -a; source .env; set +a
unset OWNER_PRIVATE_KEY DEPLOYER_PRIVATE_KEY
AGENTPROOF_APPROVAL_TIMEOUT_MS=20000 pnpm api

# Console, in a second terminal
pnpm console          # :3000
```

Check the rail reads **production** and **x402 on** before you hit record.
Do one throwaway click to warm the route — first payment is slower.

---

## 0:00 – 0:20 · The problem

**Screen:** `/` hero.

> An AI agent with a wallet is a new kind of security problem. You can't
> audit it, because it decides at runtime. You can't fully trust it,
> because anything it reads can change its mind — a web page, a tool
> response, a poisoned search result.
>
> So the question isn't "is the model good." It's: when the model is
> wrong, what stops it?

---

## 0:20 – 0:45 · What it is

**Screen:** scroll to the install block. Show `npm i @agentproof/sdk` and the snippet.

> AgentProof is a spending limit the agent can't talk its way around.
>
> It's an npm package and an HTTP API. Three lines in your agent: verify
> the transaction, and stop if it isn't allowed. If you're not in
> JavaScript, `POST /v1/verify` does the same thing.
>
> But the SDK is the convenient half. The limit is enforced on-chain,
> inside the wallet — so it holds even if the agent never calls us.

---

## 0:45 – 1:55 · The demo

**Screen:** `Try it yourself`. Click each. Let the verdict land before moving on.

> The rule here: never more than 100 USDC in one transaction.

**Click "A normal trade" → ALLOW**

> An 80 USDC swap. Inside the limits, goes through.

**Click "The AI gets tricked" → BLOCK**

> Now a prompt injection — a web page convinces the agent to send funds
> to a stranger. It's a perfectly valid transaction. It's refused,
> because that address isn't on the allowlist.

**Click "The hidden price tag" → BLOCK**

> This one's subtler. A swap that advertises a tiny amount but authorises
> 250. Read the wrong field and it looks cheap — we price it on what it
> can actually spend.

**Click "The AI asks permission" → amber pause, countdown running**

> And when a trade is big enough that you said you wanted a say, the
> agent stops. This isn't a notification — the transaction is held open,
> waiting.

**Approve it → ALLOW**

> I can approve it.

**Click it again, then say nothing. Let the countdown run to zero → BLOCK**

> Or I can do nothing. And if nobody answers, it's refused.
>
> Silence is never consent.

---

## 1:55 – 2:20 · The boundary

**Screen:** `/` architecture map. Point at the line down the middle.

> Everything left of this line is advice — useful, and skippable.
> Everything right of it is on-chain and holds whether or not anyone
> cooperates.
>
> The limit lives in an ERC-7579 hook inside the account. We tried to
> uninstall it during development and couldn't: removing it means
> executing against the account, and the hook blocks that too. The agent
> can't remove its own guardrails. Neither can we.

---

## 2:20 – 2:45 · Sponsors

**Screen:** `See the receipts`, scrolling.

> Every piece of this is deployed, and every claim links to an explorer.
>
> **Uniswap v4** — we decode Universal Router calldata to worst-case
> outflow, pinned against six real Sepolia transactions.
> **ENS v2** — the agent's limits are published under its own name, so
> anyone can check them without asking us.
> **The Graph** — a live subgraph of what the chain actually admitted.
> **Hedera** — the API is x402-gated. Every check you just watched was
> paid for, and settled on Hedera.
> **Foundry and the SMT checker** — the two core limits are proven
> correct for every possible input, not just the ones we tested.

---

## 2:45 – 3:00 · Close

**Screen:** back to `/` hero.

> Agents are going to hold money. The question is whether the limits live
> in a prompt, or somewhere the model can't reach.
>
> AgentProof puts them on-chain. `npm i @agentproof/sdk`.

---

## Accuracy notes — keep the claims this precise

- **"proven"** applies to `MAX_TRANSFER` and `DAILY_SPEND` over `PolicyLib`.
  The hook itself is fuzzed and invariant-tested, not proven. The proof
  table on the site says which is which. Don't say "the contract is
  formally verified."
- **Ledger** is implemented (`REQUIRE_APPROVAL` routes to a device, and the
  process refuses to start if hardware is enabled and absent). Don't imply
  a hardware device is in this video unless you record one.
- **Bazantic** runs against the public API. If the tunnel is down at
  record time, don't claim it live.
- The account holds ~154 USDC against a 100 limit and a 10 reserve. If
  asked, that's real, and funded from the owner EOA.
- Don't say "unhackable" or "can't be bypassed" without the qualifier:
  the hook is the boundary; the API and SDK are advisory.
