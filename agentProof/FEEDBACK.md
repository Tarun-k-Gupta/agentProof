# Developer feedback

Notes from building AgentProof during ETHOnline 2026. Written as we went rather
than reconstructed at submission time, so the rough edges are the ones we
actually hit.

## Uniswap

Universal Router calldata is not policy-checkable without writing a decoder, and
that is a real gap for the agent ecosystem. Any wallet, guard contract or policy
engine that wants to bound an agent's spend has to answer "how much can this call
cost me, at most" — and for `execute(bytes commands, bytes[] inputs)` that
requires understanding the whole command stream. There is no canonical library
for it outside the router itself. The command byte layout is documented; the
per-command input layouts are effectively learned from reading source.

The specific trap: for exact-output swaps the number that binds is
`amountInMaximum`, not the quoted input. A decoder that reads the quote
under-reports the worst case, and a limit built on it can be exceeded without
ever being violated on paper. We publish ours as `@agentproof/sdk/decode/uniswap`
so nobody else has to rediscover that.

**Suggestion.** A first-party `decodeCommands(calldata)` helper, or an official
worst-case-input ABI, would remove an entire class of silent failure for agent
tooling.

Sepolia v4 pool liquidity was thin for the pairs we wanted, which pushed us
toward seeding our own pool for the demo. Documented deployment addresses were
accurate and easy to find, which is more than we can say for some stacks.

## The Graph

Subgraph Studio was the smoothest part of our build.

The gap: indexer lag is not an edge case when the indexed value authorises
something. For a spending limit, "a few blocks behind" is a window in which an
agent can overspend. We reconcile every read against the on-chain accumulator and
trust whichever source permits less. A documented pattern for indexed-value vs.
contract-state reconciliation would be valuable, because the naive version is a
real vulnerability and nothing in the docs warns you about it.

## Hedera / x402

The partially-signed-transaction scheme is a good fit for agent payments — the
agent never needs to hold gas, which removes an entire class of problem.

The gap: verify the facilitator's `/supported` endpoint before building on it. A
facilitator that accepts a payment challenge but cannot settle looks exactly like
success until you demonstrate it. We made our server refuse to start if
`/supported` does not list our network with the expected scheme. A facilitator
conformance check, or a documented health-check-before-trust pattern, would
prevent teams shipping something that only appears to work.

## ENS v2

Enhanced Access Control is the most interesting primitive we used all event and
it is under-sold in the docs. Granting "may edit exactly this record, on exactly
this name" let us express our entire agent/owner trust split in the namespace
rather than in application code — the owner repoints the policy, the agent can
only flip its own status. That is a security property, not a convenience. A
worked example of a multi-party role split on a single name would save every team
the afternoon we spent reading role bitmaps.

The beta contracts are clearly labelled, which we appreciated; a versioned
address manifest for the Sepolia deployment would help teams stop inventing their
own. We pinned ours in `deployments/ensv2-sepolia.json`.

## ERC-7579

The `preCheck`/`postCheck` signatures changed across drafts, and older accounts
expose `postCheck(bytes)` only. Pin the account implementation and read its
HookManager before writing a module — we budgeted two hours for this and used
them. A version-tagged compatibility table in the ERC would save every hook
author the same afternoon.
