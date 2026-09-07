# AgentProof

**A safety runtime for autonomous agents. Trust the agent to decide; don't trust it to enforce its own limits.**

AgentProof sits between an AI agent and its execution layer. An SDK evaluates every
proposed action against explicit policy, and an ERC-7579 hook enforces the critical
subset at the wallet boundary — so a compromised or hallucinating agent cannot exceed
its limits even if it bypasses the SDK entirely.

```
Decide  →  Propose  →  Verify        →  Enforce       →  Execute
(LLM)      (SDK)       (SDK + Graph)    (onchain hook)   (Uniswap / Hedera)
```

---

## The problem with application-level guardrails

Almost every agent safety tool available today is a wrapper: it inspects what the
agent asks for and refuses the bad ones. That works right up until the moment it
matters, because the thing being constrained is the same process doing the
constraining. A compromised agent skips the wrapper. A prompt-injected agent is
still "asking nicely". A hallucinating agent produces calldata the wrapper never
learned to read.

AgentProof splits the job in two:

| Layer | Knows | Trusted for | Can be bypassed? |
|---|---|---|---|
| **L1 — SDK** | seven policy types, historical spend, can ask a human | good decisions, rich reasons, UX | yes, and we assume it will be |
| **L2 — hook** | two invariants and an allowlist | the limits, absolutely | no, short of the owner key uninstalling it |

The test that makes this real is in `contracts/test/integration/RealAccount.t.sol`:

```solidity
function test_RejectsUserOpThatBypassesTheSdkEntirely() public { … }
```

The hook is installed on the **ERC-7579 reference account** (MSAAdvanced, pinned
in `contracts/lib`) and driven with real `PackedUserOperation`s through a real
EntryPoint v0.8. Nothing in the call path knows about AgentProof except the hook.
The EntryPoint accepts a validly-signed operation, the account refuses it, and no
funds move.

That suite exists because the mock-only version of it hid a real bug for weeks:
`AgentPolicyHook.postCheck` took `(bytes, bool, bytes)`, a *draft* ERC-7579
signature. Every shipped account calls `postCheck(bytes)` — different selector,
`0x173bf7da` against `0xaacbd72a`. The hook would have installed cleanly and then
reverted on the account's first execution. `MockAccount` was written against the
same draft, so the mock and the hook agreed with each other while both disagreed
with reality.

---

## Quick start

```bash
pnpm install
pnpm demo          # the full demo, offline, no keys required
pnpm test          # 148 tests (103 SDK + 45 API), incl. a differential fuzz across 4,000 sequences
pnpm contracts:test    # 31 Foundry tests, incl. Gate G1 against a real 7579 account
pnpm verify:formal     # SMTChecker: MAX_TRANSFER + DAILY_SPEND, plus the negative control
```

The demo runs against an in-process model of the account and hook
(`SimulatedAccount`), so it needs no network, no keys and no deployed contracts.

For the dashboard, run the API and the UI side by side:

```bash
AGENTPROOF_ADMIN_TOKEN=… pnpm api    # :8402  the Verification API
pnpm dashboard                        # :3000  the Next.js control plane
```

The dashboard proxies the API through a Next rewrite, so the session cookie is
same-origin and there is no CORS credentials negotiation to get wrong.

To run the identical script against real Sepolia:

```bash
AGENTPROOF_LIVE=true SEPOLIA_RPC_URL=… AGENT_SESSION_KEY=… SMART_ACCOUNT_ADDRESS=… pnpm demo
```

Nothing about the steps changes when the chain becomes real — same policy file,
same bypass, same revert. Incomplete configuration falls back to the simulator
*loudly*: a demo that silently degrades to fake transactions is worse than one
that says it is simulated.

### Using the SDK

```ts
import { createAgentProof, ENSIdentity, GraphStateProvider } from '@agentproof/sdk';

const chain = new JsonRpcChainReader({ url: process.env.SEPOLIA_RPC_URL!, chainId: 11155111 });

const proof = await createAgentProof({
  policy: './agent.policy.json',
  identity: new ENSIdentity({ chain, universalResolver }),
  state: new GraphStateProvider({ endpoint, apiKey, hook, chain }),
  enforcement: {
    executor: new EoaExecutor({ account, agentSigner }),
    chain,   // enables the third leg of the hash binding
  },
});

const account = await proof.protect();
const result = await account.execute(action);   // ALLOW | BLOCK | REQUIRE_APPROVAL
```

`createAgentProof` is async because startup is not a formality. Before the first
decision it validates the policy, compares its hash against the one published in
the agent's ENS record **and** the one stored in the installed hook, checks the
agent has not been suspended, and loads whatever proof artifacts exist. Any
mismatch throws — an agent whose three published commitments disagree does not
get to run with the most permissive one. It also refuses to run against an
account with no hook installed, because advice with nothing behind it reads as
enforcement.

The hook check requires a `ChainReader`. Without one the SDK logs a warning
saying the binding was **not** verified rather than quietly checking two legs and
calling it three.

---

## Provenance: the idea the whole codebase rests on

A policy limit is meaningless unless the number it compares against is derived
from the transaction itself. Every amount carries a provenance tag:

| Provenance | Meaning | Trusted? |
|---|---|---|
| `DECLARED` | the agent said so | never |
| `DECODED` | parsed from calldata by a known-selector decoder | for allowlisted shapes |
| `MEASURED` | balance delta across execution | authoritative |

L1 decides on `DECODED`. L2 enforces on `MEASURED`.

Two consequences worth stating out loud:

- **An approval's worst-case outflow is the entire allowance**, not zero and not
  what the agent intends to spend. An unlimited approval is an unbounded outflow,
  so no finite limit can accommodate it and it always blocks.
- **For an exact-output swap the binding number is `amountInMaximum`**, never the
  quote. A decoder that reads the quote under-reports the worst case, and a limit
  built on it can be exceeded without ever being violated on paper.

Calldata no decoder claims is classified `UNKNOWN` and blocked. Refusing to
decide on bytes you cannot read is the whole discipline — a decoder that guesses
is worse than no decoder, because it produces a number that looks authoritative.

---

## Sponsor integrations

Six, each load-bearing rather than decorative. What is *built* and what is
*qualified* are different things, and the difference is stated per integration
in [`docs/future-work.md`](docs/future-work.md) — anything needing an external
account, hardware or public hosting cannot honestly be called complete from
inside this repository, and is not.

### ENS v2 — agents as namespaces

An agent is not an address with a nickname. It is a namespace:

```
trader.agentproof.eth
  addr                     → the agent's ERC-7579 smart account
  text agentproof.policy   → policyHash (keccak256 of the canonical policy JSON)
  text agentproof.hook     → the deployed AgentPolicyHook
  text agentproof.status   → active | suspended
```

Enhanced Access Control is what makes this more than a lookup. The roles encode
the trust model directly in the namespace:

| Holder | Role | On | Meaning |
|---|---|---|---|
| owner (human/Ledger) | `ROLE_SET_POLICY_RECORD` | the agent's name | only a human can repoint the policy |
| agent session key | `ROLE_SET_STATUS_RECORD` | the agent's name | the agent may suspend itself, and nothing else |
| registrar | `ROLE_REGISTRAR｜ROLE_RENEW` | root | may mint agent subnames |

The agent can act inside its namespace but cannot rewrite the namespace's rules —
the same asymmetry the hook enforces over funds, expressed over identity.

`AgentSubnameRegistrar.sol` deploys our own subname registry; `ENSIdentity`
resolves through the Universal Resolver and refuses to start on a hash mismatch.

The asymmetry is a test, not a claim —
`contracts/test/AgentSubnameRegistrar.t.sol`:

```
test_AgentKeyCannotWidenItsOwnPolicy      the agent's key is refused
test_OwnerKeyCanRepointThePolicy          the owner's key is not
test_AgentKeyMaySuspendItself             the agent's one permission, exercised
```

Those reverts come from the registry's EAC role check. A permission we enforced
ourselves, in a modifier, would be a permission we could quietly drop.

### The Graph — historical state that decides

`subgraphs/agent-history/` indexes the hook's own `SpendRecorded` events, so the
history records what the chain *admitted*, not what an agent intended.
`GraphStateProvider` reads cumulative spend from it, and the daily-spend policy
decision is made from the query result.

Indexer lag is handled explicitly rather than wished away. Every read is
reconciled against the hook's on-chain accumulator, and when the two disagree we
believe **whichever source permits less**. If both are unreachable the SDK fails
closed — an agent that cannot establish how much it has already spent must not
spend more. All four states are fixture-tested in `tests/unit/state.test.ts`.

A second, public subgraph answers a different question: `UniswapPoolProvider`
reads the deepest pool for a swap's pair, and `PoolLiquidityPolicy` refuses a
swap into a venue too thin to trade in. Bounding the *spend* and bounding the
*loss* are different problems — 80 USDC of outflow is 80 USDC whether it buys
something or nothing.

Pool state is three-valued, and the distinction is load-bearing: a pool, no pool,
or *we could not ask*. Collapsing the last two would turn an outage at The Graph
into a blanket refusal to trade.

### Hedera — the verification service is the paid product

The AgentProof verification engine is itself the x402-gated service:

```
POST /v1/verify
  → 402  { asset: USDC (HTS), amount: 0.01, network: hedera-testnet, facilitator: blocky402 }
  ← client partially signs, retries with X-PAYMENT
  → facilitator verifies + settles (facilitator pays gas)
  → 200  { decision, reason, violations, proof }
```

Ordering is deliberate: **verify before the work, settle after it**. A caller is
never charged for a request that failed — settling first would be simpler and
would quietly turn every outage into revenue.

The loop closes: an agent pays, under AgentProof policy, for an AgentProof
verification, and the payment itself is policy-checked before it is signed.

> **Framing warning.** An HTTP "is this action safe?" endpoint is, on its own,
> exactly the bypassable application-level guardrail this project argues against.
> It is advisory L1 for agents that cannot embed the SDK. The boundary is the
> on-chain hook. A sharp judge will otherwise use the API against the thesis.

### Uniswap — making v4 calldata policy-checkable

The reusable contribution is `packages/sdk/src/decode/uniswapV4.ts`, exported
standalone as `@agentproof/sdk/decode/uniswap` so other agent tooling can use it
without adopting the rest of AgentProof. It decodes a Universal Router command
stream to a **worst-case outflow, per currency**.

Three rules govern it:

1. For an exact-output swap the outflow is `amountInMaximum`, never the quote.
   The quote is what you hope to pay; the maximum is what you authorised.
2. Amounts are attributed to the currency that actually leaves. A 3 ETH swap is
   not three dollars of USDC.
3. Anything undecodable makes the whole stream `UNBOUNDED`, which exceeds every
   finite limit and so blocks or escalates.

`tests/fixtures/uniswap-sepolia.json` holds six transactions **captured from
Sepolia**, each naming its hash so any expectation can be checked against a block
explorer. Regenerate with `pnpm capture:uniswap-fixtures`. The first time that
suite ran, all six decoded to `UNBOUNDED` — v4's `SETTLE_ALL`/`TAKE_ALL` action
bytes were off by one, `amountIn` was read from the wrong word of a dynamic
struct, and command bytes were masked with `0x1f` instead of `0x3f`. None of it
was visible while the tests fed the decoder calldata from our own encoder.

Multi-hop v4 is deliberately refused rather than guessed: the captured routers
disagree with v4-periphery's published struct on where `amountIn` sits, and
reading the wrong word produced a bound off by 640 base units that looked
entirely plausible. A confident wrong number is worse than `UNBOUNDED`.

### Ledger — the human in the loop

`REQUIRE_APPROVAL` is the policy decision that routes to a device.
`selectApprover` reads `LEDGER_APPROVAL_ENABLED`; when it is on and no device can
be reached, the process **refuses to start** rather than falling back to the
dashboard. Silently downgrading hardware confirmation to a browser click is a
change to the trust model, not a decision an error handler gets to make.

The device signs the rendered, human-readable intent — recipient, asset, amount —
not raw calldata. A hardware wallet asking its owner to approve an opaque byte
string is a confirmation dialog, not consent.

### Bazantic — verify before you swap

`recipes/verify-before-you-swap.ts` chains a router quote, `/v1/decode`,
`/v1/verify`, and an execute-or-stop decision. It talks to the API over HTTP and
imports nothing from this repo's internals, so a gateway can use a hosted
AgentProof without adopting the SDK.

Failing to *obtain* a verification stops the swap, exactly like a `BLOCK`. An
agent that cannot get an answer has not got a yes. Setup and the account
prerequisites are in [`docs/integrations/bazantic.md`](docs/integrations/bazantic.md).

---

## What is proven, what is fuzzed, what is neither

This distinction is the honest core of the project, so it is stated precisely.

| Claim | Method | Status |
|---|---|---|
| `MAX_TRANSFER`, `DAILY_SPEND` over `PolicyLib` | solc SMTChecker, CHC engine | see `proofs/summary.json` |
| The hook itself | Foundry invariant campaign | fuzzed, **not** proven |
| Decoders | round-trip + captured Sepolia calldata | tested |
| L1 engine vs L2 semantics | differential fuzz, 4,000 sequences | tested, zero disagreements |

**The proof artifacts are committed**, in `proofs/`, alongside the raw solver
transcripts in `artifacts/smt/`. Both properties currently report `PROVEN` and
the negative control produces a counterexample. They are generated by
`pnpm verify:formal` and never hand-edited; regenerate rather than edit.

If you check out a tree without them, the SDK reports `NOT_RUN` and the demo says
so on screen. It never reports `PROVEN` for a proof it does not have — and the
parser now requires positive evidence (`N verification conditions proved safe`)
before writing that status, because a run where the checker never started
produces a clean log that otherwise reads exactly like success.

Getting there took two fixes worth knowing about if you extend the spec. solc
0.8.28's SMTChecker does not model `revert CustomError(...)` as terminating a
path, and it havocs memory structs — with both in place, not one property here
could be proved. `PolicyLib` is therefore split: `evaluate` is a total,
scalar-typed, non-reverting core (verified), and `applySpend` is the
struct-shaped adapter that reverts with typed errors (not verified, and not
claimed to be).

We verify a library, not the hook, and the reason is technical rather than
convenient: CHC loses precision on external calls, `delegatecall` and
cross-contract mappings — exactly what a 7579 hook is full of. `PolicyLib` has
none of those, which is the difference between a proof and a timeout.

The negative control matters as much as the proof. `PolicySpecBroken.sol` is
identical except for an off-by-one and a missing reset guard, and CI **fails if
it verifies cleanly** — a green build there would mean the checker is inert, and
every `PROVEN` beside it would be decoration.

A proof only proves the specification we wrote, under the model checked.

---

## Getting on-chain

Reads and writes are deliberately asymmetric. Every read the policy engine needs
— balances, the hook's accumulator, ENS records — is an `eth_call`, so
`JsonRpcChainReader` does them with `fetch` and **no dependencies at all**. The
thing making safety decisions has no supply chain.

Signing is not simple enough to own, so it uses viem, imported dynamically and
declared an optional peer dependency. You only pay for a wallet stack if you
actually sign something.

Two executors, and which you use does not change what is enforced — the hook
runs inside the account's execution path either way:

| Executor | Path | Use |
|---|---|---|
| `EoaExecutor` | owner EOA calls `account.execute()` | **default** |
| `BundlerExecutor` | a real ERC-4337 UserOperation | stretch, not yet run against a live bundler |

The EOA path is the default on purpose. "The bundler does not support the chosen
7579 account" is a live risk, and building the fallback first means bundler
trouble costs an afternoon of polish rather than the demo.

## Privacy

A safety runtime sees everything an agent does, which makes it a surveillance
surface by default. Four rules, implemented in `packages/sdk/src/privacy/`
rather than promised here:

1. **Evaluate locally.** The engine is in-process, has zero runtime dependencies
   and needs no network. The hosted API is for agents that cannot embed it.
2. **Log shapes, not values.** Redaction happens on the way *into* the logger, so
   there is no configuration in which a raw key reaches a log line. Addresses are
   truncated; loose 32-byte hex is masked wherever it appears.
3. **Publish commitments, not records.** The HCS audit trail carries
   `keccak256(salt ‖ account ‖ intent ‖ decision)` — enough to prove later that an
   entry was not written after the fact, without disclosing who paid whom.
4. **Bucket public amounts.** An HCS topic is permanent and world-readable.
   Order-of-magnitude buckets keep the trail useful for "was this agent
   behaving?" and useless for "how much does this treasury hold?".

See `docs/privacy.md`.

---

## Threat model

Full version in `docs/threat-model.md`. In brief:

| # | Adversary | Defended by | Layer |
|---|---|---|---|
| T1 | Hallucinating agent | policy engine | SDK |
| T2 | Prompt-injected agent | recipient/contract allowlist | SDK + hook |
| T3 | SDK bypass | `preCheck`/`postCheck` on the account | on-chain |
| T4 | Value hidden in calldata | calldata decoding + balance-delta check | on-chain |
| T5 | Salami slicing | daily cumulative accumulator | SDK + hook |
| T6 | UTC-day boundary gaming | **accepted**, documented, not fixed | — |
| T7 | Policy tampering by the agent | ENS EAC roles + owner-only writes | on-chain |
| T8 | Malicious module uninstall | requires the owner validator | account config |

**Explicit non-defenses.** We do not defend against a compromised owner key
(owner ≠ agent by design). We do not verify the LLM — we verify the
deterministic boundary around it. Slippage and MEV on an executed swap are out of
scope: we bound spend, not execution quality.

**Known gaps**, stated rather than hidden: `delegatecall` executions are not
analysed and should be disallowed for the agent validator; only the configured
asset is tracked, so a swap spending WETH is bounded only by the allowlist;
cross-UserOp approval draining by an allowlisted target is out of scope; batch
executions revert in the MVP. Each has a one-line mitigation in the demo config
(single asset, single allowlisted router, no batching).

---

## Repository layout

```
packages/sdk/          @agentproof/sdk — the product. Zero runtime dependencies.
  src/adapters/        JsonRpcChainReader (zero-dep reads), EoaExecutor, BundlerExecutor, viem signer
  src/core/            PolicyEngine, AgentProof, policy parsing + canonical hash
  src/policies/        the six MVP policies, plus poolLiquidity (advisory only)
  src/decode/          erc20, uniswapV4, x402, native, registry
  src/identity/        ENSIdentity (ENSv2, Universal Resolver)
  src/state/           Memory, Graph and Uniswap-pool state providers
  src/approval/        Console, Dashboard, Ledger approvers + selectApprover
  src/privacy/         redaction, commitments, public-record projection
  src/ports/           every external system, behind one interface
  src/testing/         SimulatedAccount — a faithful in-process model of the hook
  tests/fixtures/      real Sepolia calldata, each entry naming its tx hash
packages/api/          the Verification API, x402-gated, node:http, no framework
packages/x402-client/  payment client that policy-checks its own payments
apps/dashboard/        Next.js split-pane control plane. Reads only, bar approval.
apps/agents/           trader (LangGraph) and researcher (x402)
contracts/             AgentPolicyHook, PolicyLib, AgentSubnameRegistrar
  formal/              PolicySpec (proves) + PolicySpecBroken (must not)
  test/integration/    Gate G1: the hook on a real 7579 account + EntryPoint
  lib/                 pinned deps, gitignored — CI reinstalls them
subgraphs/             agent-history: the hook's events, indexed
recipes/               verify-before-you-swap, for gateways and other runtimes
proofs/ artifacts/smt/ generated proof artifacts and raw solver transcripts
scripts/               demo-runner, formal verification, fixture capture, deploy checks
docs/                  threat model, formal verification, privacy, future work
```

Two rules: `deployments/*.json` is the single source of truth for addresses, and
`proofs/*.json` is generated, never hand-edited.

Two pinned versions are load-bearing and were arrived at the hard way — see the
note at the foot of `contracts/foundry.toml`. The short version: the ERC-7579
reference account at v0.3.1, and account-abstraction at **v0.8.0**, because v0.7
predates `ISenderCreator` and v0.9 gates `handleOps` behind
`tx.origin == msg.sender`.

---

## Architecture notes worth defending

**Why a hook, not a guard contract.** The obvious alternative is a contract with
`executeAction(agent, to, amount, data)` that the agent calls instead of its
wallet. It fails three ways: it is an arbitrary-call proxy, and a honeypot if it
holds funds; `amount` is supplied by the same caller whose spending is being
limited and has no relationship to `data`, so proving `amount <= maxTransaction`
enforces nothing; and it cannot deliver the demo's key moment, because a separate
contract the agent can simply *not call* is not a boundary.

**Outflow is a balance delta, not a parameter.** This is what defeats T4. The
hook never reads a declared amount.

**The allowlist is checked in `preCheck`, the accumulator written in `postCheck`.**
Cheap rejection before any state change; and we count what actually happened
rather than what was intended.

**Batches revert.** A batch that splits a spend across calls is a real bypass of a
per-call check, so rejecting them is the safe default. It is a scope limit, and
it is documented rather than discovered.

---

## Future work and known gaps

[`docs/future-work.md`](docs/future-work.md) is the honest list: what is proven
versus fuzzed versus pinned versus simulated versus advisory, the enforcement
gaps (delegatecall, batching, multi-asset accounting, cross-UserOp approval
draining, the UTC-day boundary, the per-process replay guard), the decoding gaps,
and a per-sponsor status table.

The headline items: multi-asset accounting with a price oracle; a rolling
24-hour window instead of UTC-day buckets, removing T6; batch support with
per-call decomposition; policies as ERC-1155 tokens under the ENSv2 registry;
Certora specs for the stateful hook rather than the pure library; and a validator
module that rejects at signature time, so over-limit UserOps never reach the
bundler and never cost gas.

## Licence

MIT.
