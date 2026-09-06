# Developer feedback

Notes from building AgentProof during ETHOnline 2026. Written as we went rather
than reconstructed at submission time, so the rough edges are the ones we
actually hit.

## Uniswap

**Universal Router calldata is not policy-checkable without writing a decoder.**
This is the gap our SDK fills, and it is a real one for the agent ecosystem. A
wallet, a guard contract or a policy engine that wants to bound an agent's spend
has to answer "how much can this call cost me, at most" — and for
`execute(bytes commands, bytes[] inputs)` that requires understanding the command
stream. There is no canonical library for this outside the router itself.

The specific trap: for exact-output swaps, the number that binds is
`amountInMaximum`, not the quoted input. A decoder that reads the quote will
under-report the worst case, and a limit built on it can be exceeded without
ever being violated on paper. We publish our decoder as
`@agentproof/sdk/decode/uniswap` so nobody else has to rediscover that.

**Suggestion.** A first-party `decodeCommands(calldata)` helper, or an official
worst-case-input ABI, would remove an entire class of silent failure for agent
tooling. The command byte layout is documented; the per-command input layouts
are effectively learned from the source.

**Sepolia v4 pool liquidity was thin** for the pairs we wanted, which pushed us
toward seeding our own pool for the demo. Documented deployment addresses were
accurate and easy to find, which is more than we can say for some stacks.

## ERC-7579

The `preCheck`/`postCheck` signatures changed across drafts, and older accounts
expose `postCheck(bytes)` only. Pin the account implementation and read its
HookManager before writing a module — we budgeted two hours for this and used
them. A version-tagged compatibility table in the ERC would save every hook
author the same afternoon.

## The Graph

Subgraph Studio was the smoothest part of the build. One thing that took a while
to get right conceptually rather than technically: indexer lag is not an edge
case for a spend limit, it is the normal condition. We ended up reconciling every
read against the on-chain accumulator and trusting whichever source permits less.
A documented pattern for "indexed value vs contract state" reconciliation would
be genuinely useful, because the naive version of this is a real vulnerability.

## ENS v2

Enhanced Access Control is the most interesting primitive we used all event, and
it is under-sold in the docs. Being able to grant "may edit exactly this record
on exactly this name" let us express our entire agent/owner trust split in the
namespace itself rather than in application code.

The contracts are beta and say so. We pinned addresses and recorded them in
`deployments/ensv2-sepolia.json`. `ens-cli` was useful for ops scripting; we kept
it out of the SDK as the docs advise.

## Hedera / x402

Verify the facilitator's `/supported` endpoint before building anything on it.
The partially-signed-transaction scheme is a good fit for agent payments —
the agent never needs gas — but the failure mode where a facilitator accepts a
challenge and cannot settle looks exactly like success until it is demonstrated,
so we made the server refuse to start if `/supported` does not list our network.
