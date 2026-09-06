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
| **L1 — SDK** | six policy types, historical spend, can ask a human | good decisions, rich reasons, UX | yes, and we assume it will be |
| **L2 — hook** | two invariants and an allowlist | the limits, absolutely | no, short of the owner key uninstalling it |

The test that makes this real is in `contracts/test/AgentPolicyHook.t.sol`:

```ts
it('rejects a UserOp that bypasses the SDK entirely', ...)
```

No SDK is involved anywhere in that test. The account executes directly and the
hook still stops it.

---

## Quick start

```bash
pnpm install
pnpm demo          # the full demo, offline, no keys required
pnpm test          # 80 tests, including a differential fuzz across 4,000 sequences
```

The demo runs against an in-process model of the account and hook
(`SimulatedAccount`), so it needs no network, no keys and no deployed contracts.

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

Three, each load-bearing rather than decorative.

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

### The Graph — historical state that decides

`subgraphs/agent-history/` indexes the hook's own `SpendRecorded` events, so the
history records what the chain *admitted*, not what an agent intended.
`GraphStateProvider` reads cumulative spend from it, and the daily-spend policy
decision is made from the query result.

Indexer lag is handled explicitly rather than wished away. Every read is
reconciled against the hook's on-chain accumulator, and when the two disagree we
believe **whichever source permits less**. If both are unreachable the SDK fails
closed — an agent that cannot establish how much it has already spent must not
spend more.

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

---

## What is proven, what is fuzzed, what is neither

This distinction is the honest core of the project, so it is stated precisely.

| Claim | Method | Status |
|---|---|---|
| `MAX_TRANSFER`, `DAILY_SPEND` over `PolicyLib` | solc SMTChecker, CHC engine | see `proofs/summary.json` |
| The hook itself | Foundry invariant campaign | fuzzed, **not** proven |
| Decoders | round-trip + captured Sepolia calldata | tested |
| L1 engine vs L2 semantics | differential fuzz, 4,000 sequences | tested, zero disagreements |

**There are no proof artifacts in this repository by default.** `proofs/*.json` is
generated by `pnpm verify:formal` and gitignored. Until you run it, the SDK
reports `NOT_RUN` and the demo says so on screen. It never reports `PROVEN` for a
proof it does not have.

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
| `BundlerExecutor` | a real ERC-4337 UserOperation | stretch |

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
  src/policies/        the six MVP policies
  src/decode/          erc20, uniswapV4, x402, native, registry
  src/identity/        ENSIdentity (ENSv2, Universal Resolver)
  src/state/           Memory and Graph state providers
  src/privacy/         redaction, commitments, public-record projection
  src/ports/           every external system, behind one interface
  src/testing/         SimulatedAccount — a faithful in-process model of the hook
packages/api/          the Verification API, x402-gated, node:http, no framework
packages/x402-client/  payment client that policy-checks its own payments
contracts/             AgentPolicyHook, PolicyLib, AgentSubnameRegistrar
  formal/              PolicySpec (proves) + PolicySpecBroken (must not)
subgraphs/             agent-history: the hook's events, indexed
apps/agents/           trader (LangGraph) and researcher (x402)
scripts/               demo-runner, formal verification pipeline
```

Two rules: `deployments/*.json` is the single source of truth for addresses, and
`proofs/*.json` is generated, never hand-edited.

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

## Future work

Multi-asset accounting with a price oracle. A rolling 24-hour window instead of
UTC-day buckets, removing T6. Batch support with per-call decomposition. Policies
as ERC-1155 tokens under the ENSv2 registry, transferable and revocable. Certora
specs for the stateful hook, not just the pure library. A validator module that
rejects at signature time, so over-limit UserOps never reach the bundler and never
cost gas.

## Licence

MIT.
