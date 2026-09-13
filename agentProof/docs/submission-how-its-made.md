# How it's made

AgentProof is a TypeScript SDK, an HTTP verification API, and an ERC-7579 hook
that enforces spending limits inside an agent's smart account. The design rule
throughout: anything off-chain is advice, and the only thing that actually
stops a transaction is on-chain.

**The decision path has zero dependencies.** Every read the policy engine needs
is an `eth_call` issued with `fetch`. viem is an optional peer dep, dynamically
imported, and only if you sign — so you don't take a wallet stack's supply
chain into the code that decides whether an agent may spend your money. Seven
policies run per action: allowlist, max transaction, daily spend, minimum
balance, approval threshold, pool liquidity, and unlimited-approval detection.

**Decoding is where the real work is.** A policy is only as good as its
understanding of the calldata. `decode/uniswapV4.ts` walks a Universal Router
command stream and returns worst-case outflow per currency. The trap is
exact-output swaps: the interesting number is `amountInMaximum`, not the quote,
and reading the wrong field lets a 250 USDC swap look like a 1 USDC one.
Anything undecodable returns `UNBOUNDED` rather than a guess, and unbounded
always blocks. We pinned the decoder against six real Sepolia transactions —
the first run decoded all six as `UNBOUNDED` because of an off-by-one in the
action bytes and a wrong struct word, invisible until real calldata replaced
our own self-encoded fixtures. That bug is the argument for the whole approach.

**Uniswap v4** is therefore load-bearing rather than decorative: the Universal
Router and PoolManager are the allowlisted targets, and a second public Uniswap
subgraph feeds a pool-liquidity policy — bounding *spend* and bounding *loss*
are different problems.

**The hook** is an ERC-7579 module on an MSAAdvanced account (reference impl
v0.3.1) driven through EntryPoint **v0.8.0**. The version is pinned deliberately:
v0.7 predates `ISenderCreator`, and v0.9 gates `handleOps` behind
`tx.origin == msg.sender`. We also had to match the account's actual
`postCheck(bytes)` — selector `0x173bf7da` — not the draft
`postCheck(bytes,bool,bytes)`, and there's an integration test that installs the
hook on a real 7579 account and drives it through a real EntryPoint to prove it.

**Formal verification** with solc's SMTChecker proves `MAX_TRANSFER` and
`DAILY_SPEND` hold over `PolicyLib` for all inputs, in about 1.3 seconds. We
also compile a deliberately broken spec, `PolicySpecBroken`, which *must*
produce a counterexample — that's how we know the solver is actually looking
rather than trivially passing. The hook itself is fuzzed and invariant-tested,
not proven, and the UI says which is which. Missing artifacts report `NOT_RUN`
instead of passing silently.

**ENS v2** carries the agent's identity as a namespace: `addr` to the smart
account, and text records for policy hash, hook address, and status. The EAC
roles encode the trust split precisely — the owner holds
`ROLE_SET_POLICY_RECORD`, and the agent's session key holds only
`ROLE_SET_STATUS_RECORD`, so an agent can suspend itself and nothing else. The
SDK does a three-way binding check at startup: local file, ENS record, and the
hook's stored hash must agree, or it refuses to run.

**The Graph** indexes the hook's own `SpendRecorded` events, so history reflects
what the chain admitted rather than what an agent intended. A pre-aggregated
`DailyAggregate` entity is what keeps a policy decision fast enough for an
agent's hot path. Subgraph reads are reconciled against a direct on-chain
accumulator read, whichever source permits *less* wins, and if both are
unreachable the SDK fails closed.

**Hedera** makes the verification service the paid product. `POST /v1/verify`
returns 402 with payment requirements; the client partially signs a transfer;
the Blocky402 facilitator co-signs as fee payer and settles; then the verdict
comes back. Verify before work, settle after — callers are never charged for
failed requests. Each settlement is written to an HCS topic, so an audit trail
exists on infrastructure we don't control. The loop closes nicely: the payment
itself is a policy-checked action, so an agent can't be talked into paying a
thousand dollars for a data query by a service that simply asks for it.

## Hacky bits worth mentioning

**The browser can't pay, so the server pays for it.** The demo UI needed the
x402 gate switched *on* to be honest, but a browser has no wallet — every check
was just a 402. The console's verify route now answers the challenge itself
with a Hedera signer, so the gate stays on and every click in the demo is a
real settlement with the transaction id linked to HashScan. First attempt
refused every call: `maxPricePerCall` is in atomic units and we'd written it in
display units, so `0.01` was compared against `90`. The ceiling was right; the
units were ours.

**Next.js gives up on proxied requests at 30 seconds.** When an action needs
human approval, our API holds the HTTP request open until someone answers — the
agent is genuinely stopped, not notified. Through Next's `rewrites()` proxy that
died with a 500 at exactly 30.0s. We moved `/v1/verify` to its own route handler
that owns the connection; everything else still goes through the rewrite.

**The SSE stream replays its last 50 events to new subscribers**, which is lovely
for a late-joining tab and terrible for approvals — a page load rendered a
live-looking Approve/Decline card for a decision settled ten minutes earlier. An
approval is now only accepted while one of our own requests is actually in
flight.

**Importing the SDK barrel breaks the Next build.** The barrel reaches
`approval/ledger.ts`, whose dynamic transport import can't be statically
bundled, and page-data collection dies on it — in the production build only, so
dev never catches it. The fix is subpath exports (`@agentproof/sdk/calldata`,
`/decode/x402`) for anything a bundler has to touch.

**We couldn't uninstall our own hook.** Updating the policy on a live account
means executing against the account itself, and the hook rejects any target
that isn't allowlisted — including the account. `uninstallModule` is `withHook`
on MSAAdvanced, so calling it directly re-enters the same check. The agent's
session key cannot remove its own guardrails, which is the property we wanted,
with a consequence we hadn't planned: on this account the policy is fixed for
the life of the account. It's written up in `docs/future-work.md` with both
escape routes and why neither is free.

**The API refuses to boot if an owner private key is in its environment.** We
tripped it ourselves while wiring up the demo. It stays.
