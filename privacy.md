# Privacy

A safety runtime sees every action an agent takes. That makes it a surveillance
surface by default, and the honest response is to design against ourselves.

## Four rules

### 1. Evaluate locally

The policy engine is in-process, synchronous, and has **zero runtime
dependencies**. It needs no network to reach a decision. Nothing about an agent's
activity has to leave the machine it runs on.

The hosted Verification API exists for agents that cannot embed the SDK — a
Python or Go agent, or an LLM calling tools directly. It is stateless, holds no
keys, stores nothing, and says so in a response header. Using it is a choice with
a visible cost, not the default path.

### 2. Log shapes, not values

Redaction happens on the way *into* the logger, not at the sink. There is no
configuration in which an unredacted value reaches a log line.

- Keys matching `privateKey|apiKey|secret|mnemonic|seed|sessionKey|authorization|x-payment`
  are replaced wholesale. Not truncated — a truncated private key is still a
  meaningful reduction in search space.
- Any loose 32-byte hex string is masked wherever it appears, because that is the
  shape of both a private key and a signature. We would rather lose a hash from a
  log than leak a key into one.
- Addresses are truncated to `0x1234…cdef`: enough to correlate within a log,
  not enough to publish.
- Error paths never echo the request body. A 500 is not a reason to start logging
  calldata.
- URLs are stripped to origin + path before appearing in an error, because query
  strings carry API keys.

### 3. Publish commitments, not records

The HCS audit trail is permanent and world-readable. Writing exact amounts and
counterparties to it would publish an agent's complete cash-flow history to
anyone who cares to read — a strictly worse privacy position than having no audit
trail at all.

What actually goes on the topic:

```json
{
  "policyHash":   "0x…",         // which policy version governed — public by design
  "decision":     "BLOCK",
  "decidedBy":    "maxTransaction",
  "amountBucket": "100-1000",     // order of magnitude only
  "commitment":   "0x…",          // keccak256(salt ‖ account ‖ intent ‖ decision)
  "dayUtc":       20338           // ordering, not behavioural timing
}
```

The commitment binds the entry to the exact intent that produced it without
revealing the intent. An operator can later reveal the preimage for a **single**
entry and prove to an auditor that it was not written after the fact, without
disclosing every other entry to do so.

The salt is per-process, never logged, never transmitted, and regenerated on
restart. Without it the input space of `(account, amount, counterparty)` is small
enough to enumerate.

### 4. Bucket public amounts

`bucketAmount` coarsens to orders of magnitude before anything reaches a public
ledger. Two amounts in the same band are indistinguishable on-chain — there is a
test asserting exactly that. The trail stays useful for *"was this agent
behaving?"* and becomes useless for *"how much does this treasury hold?"*.

## The single projection point

`toPublicAuditRecord()` is the one function through which data leaves for a public
ledger. Making that a function rather than a habit is what stops the next feature
from quietly widening it.

## Data minimisation elsewhere

- Subgraph queries are keyed on account and day only. No session identifiers, no
  correlation tokens.
- No personal or sensitive data is ever placed in a URL or query string.
- The dashboard is read-only and holds no state. Closing it changes nothing.
- The API's request body limit is 256 KB, and bodies are parsed and discarded.

## What this does not protect

On-chain activity is public. AgentProof does not and cannot hide the transactions
an agent executes — those are visible on Sepolia and HashScan like any others.
What it avoids is *adding* a second, richer, permanently-published record of
intent, reasoning and exact amounts on top of what the chain already discloses.
