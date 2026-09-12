# Future work and known gaps

What this system does not do, stated plainly, because a safety product that is
vague about its edges is not a safety product.

Each item says what the current behaviour is, why it is that way, and what would
change it. Nothing here is a surprise to the code — the gaps are the ones the
tests and comments already name.

---

## What is actually proven, and what is not

The word "verified" is doing different work in different places. In order of
strength:

| Level | What it covers | Where |
|---|---|---|
| **Formally proven** | `MAX_TRANSFER`, `DAILY_SPEND`, window-monotonicity and no-mutation-on-refusal, over the scalar policy core, for unbounded call sequences | `contracts/formal/PolicySpec.sol`, `proofs/*.json` |
| **Fuzz-tested** | the hook's behaviour on a mock ERC-7579 account: measured outflow, allowlists, minimum balance, day reset | `contracts/test/`, 10,000 runs × depth 50 |
| **Pinned against real data** | the Uniswap decoder, on captured Sepolia calldata | `packages/sdk/tests/fixtures/uniswap-sepolia.json` |
| **Unit-tested only** | the TypeScript policy engine, the API, the reconciliation logic | `packages/*/tests/` |
| **Simulated** | the demo's execution path when no credentials are present | `scripts/demo-runner.ts` |
| **Advisory** | everything the HTTP API says | `POST /v1/verify` |

The proof covers `PolicyLib.evaluate`, not the hook. A 7579 hook is full of
external calls, balance reads and cross-contract mappings; CHC loses precision
on all three and returns `unknown`. Saying the hook is proven because the
library it calls is proven would be the kind of claim this table exists to
prevent.

### The proof pipeline is fragile in a specific way

solc 0.8.28's SMTChecker does not model `revert CustomError(...)` as terminating
a path, and it havocs memory structs. Both failures are silent: the checker
reports assertions as violated that plainly hold, or — if it never starts at all
— produces a clean log that reads exactly like success. The parser now requires
positive evidence before reporting `PROVEN`, and the script refuses to run
without a Horn solver, but the underlying tool limitation remains. Any new
property must be written as a total function over scalars, and any new revert
inside verified code will quietly un-verify it.

---

## Known gaps in enforcement

### Delegatecall and batched execution

`preCheck` decodes a single ERC-7579 execution and reverts on anything else.
Batch mode and delegatecall are refused rather than analysed.

Refusing is safe but blunt: a legitimate batched swap is blocked. Analysing a
batch means bounding the *composed* outflow of its members, which is not the sum
of their individual bounds — an approve followed by a transferFrom inside one
batch has the worst case of the approval, not of both. Doing this properly needs
a batch decoder that composes intents, not one that concatenates them.

### Multi-asset accounting

The hook tracks one asset: `config.asset`. Outflow is a balance delta in that
token. A policy denominated in USDC says nothing about an account draining ETH,
WETH, or any other holding.

The decoder is already per-currency — `uniswapV4Decoder` reports outflow keyed by
the currency that actually leaves — so the SDK's advisory answer is honest about
a non-USDC swap. The hook is not: it measures one balance. Closing this means
either a per-asset accumulator in the hook (storage cost per asset per day) or a
price oracle to denominate everything in one unit (an oracle dependency inside
the enforcement path, which is a much larger trust change than it looks).

### Cross-UserOperation approval draining

An approval and its exercise can land in different UserOperations. The hook
bounds each one against the per-transaction limit and the daily accumulator, and
the SDK counts an approval's worst case as the whole allowance — so a large
approval is caught at grant time. What is not caught is a sequence of small
approvals to an allowlisted spender, each individually under the limit,
exercised later. The daily accumulator catches this only once the funds actually
move, which may be on a later day.

The allowlist is the current mitigation: a spender that is not allowlisted
cannot receive an approval at all. That is a real defence and it is not a
complete one.

### The UTC-day boundary

The daily window is a UTC-day bucket, not a rolling 24 hours. Two full daily
limits can be spent a minute apart across midnight.

This is a deliberate choice, documented rather than implied: a UTC bucket is one
storage word and is trivially verifiable, and a rolling window needs either a
ring buffer of recent spends or an approximation. The proof and the invariant
campaign both describe the bucket semantics accurately. Moving to a rolling
window is a policy-schema change, not just a hook change, because the limit's
meaning changes.

### A live policy hook cannot be replaced

Confirmed on Sepolia, not theorised. `AgentPolicyHook.preCheck` rejects every
execution whose target is not in `allowedTarget`. Uninstalling a module means
executing against the account itself, and the account is not one of its own
allowed targets — so `scripts/install-hook.ts` reverts during estimation with
`TargetNotAllowed(0x67b9ee…d441)`. Calling `uninstallModule` directly is no
different: on MSAAdvanced it carries `withHook`, so it re-enters the same check.
`AgentPolicyHook` has no owner-only override, and `allowedTarget` is written
only inside `onInstall`.

This is the enforcement working. An agent's session key cannot remove its own
guardrails, which is the property the whole design exists to provide. The cost
is that the policy on `0x67B9Ee…D441` is now fixed for the life of the account:
the three-way binding (file, ENS record, hook) can only be moved in two of its
three legs, so the policy file and the ENS record must stay at
`0xf40b489f…556900` to match the hook.

Two ways out, neither free:

- **Allowlist the account at install time.** Include the account in
  `allowedContracts` so a future `uninstallModule` passes `preCheck`. This also
  lets the session key call the account for anything else, including
  uninstalling the hook — which gives back exactly the power the hook exists to
  remove. It would want a target-plus-selector allowlist rather than a
  target-only one.
- **An owner-authorised replacement path on the hook.** `preCheck` cannot tell
  which validator signed the UserOp, so this means a hook-level owner recorded
  at install, and a bypass for the owner is still a bypass. It needs a written
  threat-model argument before it is written as code.

Until then, replacing a policy means deploying a new account: new address, new
subgraph start block, new ENS registration.

Worth separating from a bug this masked: nothing in the demo or the console
actually needed a wider policy. Both were routing swap output to the
enforcement account, which is not on its own recipient allowlist, so every swap
failed the allowlist before reaching the limit it was meant to exercise. That
was a caller bug, fixed in both. The hook's immovability is a real constraint;
it was not the reason anything was failing.

---

### The replay guard is per-process

`ReplayGuard` stops an x402 payment payload from buying more than one call, in
memory, in one process. Behind a load balancer, each process has its own view.
The settlement record on Hedera remains the authority on what was actually paid;
the guard is a reuse rate-limit, not a distributed ledger.

---

## Known gaps in decoding

### Multi-hop v4 swaps are refused, not bounded

`SWAP_EXACT_IN` (0x07) and `SWAP_EXACT_OUT` (0x09) return UNBOUNDED. The
single-hop layouts are pinned against captured Sepolia calldata; the multi-hop
ones are not, and the routers we captured disagree with v4-periphery's published
`ExactInputParams` on where `amountIn` sits. Reading the wrong word produced a
bound that was off by 640 base units and looked entirely plausible.

An UNBOUNDED intent exceeds every finite limit, so it blocks or escalates — the
conservative failure. Closing this needs calldata from a router whose struct
layout can be confirmed against its verified source, not another guess.

### Third-party router extensions

Several Sepolia routers implement command bytes outside the Universal Router
set. Command `0x07` on one of them takes `(token, recipient, amount)`, which is
not any documented Universal Router command. Unknown commands make the whole
stream unbounded, which is correct and also means a policy that allowlists such
a router will escalate on most of its traffic.

### Batch and permit2 batch variants

`PERMIT2_PERMIT_BATCH` (0x03) and `PERMIT2_TRANSFER_FROM_BATCH` (0x0d) are not
modelled. Same conservative outcome.

---

## Sponsor integrations: what is qualified and what is not

| Integration | Status |
|---|---|
| The Graph | reconciliation logic tested against fixtures for all four indexer states; a live subgraph deploy needs the hook's address and start block, which need a deploy |
| Uniswap | decoder pinned against six captured Sepolia transactions; the reusable export is `@agentproof/sdk/decode/uniswap` |
| ENSv2 | contracts and resolver written; registration needs a funded Sepolia deployer and the ENSv2 beta addresses pinned in `deployments/ensv2-sepolia.json` |
| Hedera | x402 gate and HCS audit trail tested end to end against a fake facilitator and submitter; a live paid request needs a funded Hedera account and a facilitator that advertises `hedera-testnet` |
| Ledger | `DashboardApprover` is the working default; `LedgerApprover` is behind `LEDGER_APPROVAL_ENABLED` and needs hardware to qualify |
| Bazantic | recipe runs locally; gateway qualification needs an account and a publicly reachable API — see `docs/integrations/bazantic.md` |

Anything above that needs an external account, hardware, or public hosting
cannot honestly be marked complete from inside this repository, and is not.

---

## Deployment

`deployments/sepolia.json` records verified addresses for USDC, the v4
PoolManager, Permit2 and the Universal Router, and zero addresses for the hook,
the smart account and the account implementation — none of which have been
deployed. `pnpm verify:deployment` reports both bytecode presence and recent log
activity for every address, which is what caught the repo allowlisting a real
but unused pre-v4 router.

The API refuses to start in production mode while any required address is still
zero. That is deliberate: a verification service that boots against a hook which
does not exist is a verification service that says ALLOW to everything.
