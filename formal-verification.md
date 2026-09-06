# Formal verification

## Scope statement

> We formally verify the deterministic policy arithmetic that governs on-chain
> enforcement. We do not verify the LLM, the SDK, or the external protocols. The
> proof holds for the modeled system: the `PolicyLib` state machine, unbounded
> `uint256` arithmetic under Solidity 0.8 checked semantics, and an arbitrary
> adversarial sequence of `applySpend` calls.

## The properties

Exactly two, and that is deliberate. Two proven beats six unproven.

```
P_MAX_TRANSFER    outflow_i <= maxTransaction, for every i
P_DAILY_SPEND     sum(outflow within one UTC day) <= dailyLimit
P_WINDOW_FORWARD  the window day never moves backwards
```

## Why we verify a library, not the hook

SMTChecker's CHC engine loses precision quickly on contracts with external calls,
`delegatecall` and cross-contract mappings — exactly what a 7579 hook is full of.
It returns `unknown` and a day is gone.

```
PolicyLib.sol         pure functions + explicit state struct   ← VERIFIED HERE
      ▲
      │ used by
AgentPolicyHook.sol   external calls, balances, account glue   ← fuzzed, not proven
```

`PolicyLib` has no external calls, no dynamic arrays, and models its only state as
a struct parameter. That is the difference between a proof and a timeout.

**The hook itself is fuzzed, not proven. We say so everywhere the claim appears.**

## Running it

```bash
pnpm verify:formal
```

Requires `solc` 0.8.28 with an SMT solver:

```bash
pip install solc-select z3-solver
solc-select install 0.8.28 && solc-select use 0.8.28
```

The script runs two checks and writes `proofs/*.json`.

## The negative control

`contracts/formal/PolicySpecBroken.sol` is identical to `PolicySpec.sol` except
for two injected bugs: the UTC-day reset guard is missing, and the daily
comparison is off by one. SMTChecker must produce a concrete counterexample
trace for it.

**CI fails if the broken spec verifies cleanly.** This is not a nicety. A green
build on the broken contract would mean the model checker is not actually
running — and every `PROVEN` beside it would be decoration. "Here is the
property; here is what the solver says when we break it" is worth more than two
green checkmarks.

`parse-smt-output.mjs` also refuses to emit `PROVEN` artifacts at all if solc
reports no SMT solver available, rather than mistaking silence for success.

## What the artifacts mean

```json
{
  "property": "MAX_TRANSFER",
  "status": "PROVEN",
  "tool": "solc-smtchecker",
  "solverTimeMs": 1284,
  "artifactPath": "proofs/MAX_TRANSFER.json"
}
```

`status` is one of:

| Status | Meaning |
|---|---|
| `PROVEN` | the solver discharged the property over the whole reachable state space |
| `UNPROVEN` | the solver returned `unknown`, or timed out. **Not** a failure, and **not** a success |
| `COUNTEREXAMPLE` | the property is false and the solver produced a trace |
| `NOT_RUN` | no artifact exists. The default in a fresh checkout |

The SDK loads these at init and attaches the matching reference to any decision
whose *deciding* policy is covered. A proof badge never appears on a decision it
does not cover — attaching `MAX_TRANSFER` to an allowlist block would be proof
theatre.

## Complementary testing

| Layer | Tool | Target |
|---|---|---|
| Pure logic | SMTChecker CHC | the two invariants, exhaustively |
| Stateful hook | Foundry invariant campaign | `sum(day outflow) ≤ dailyLimit` against the real hook and a mock ERC-20 |
| Decoders | round-trip + captured Sepolia calldata | decoded amount equals measured delta |
| Differential | TS `PolicyEngine` vs simulated L2 semantics | the two never disagree on ALLOW/BLOCK |

The differential suite is the sleeper. "Our off-chain engine and our on-chain
enforcement are fuzz-tested to agree" is a specific, checkable claim, and the
failure it guards against is nasty in both directions: an action the SDK waves
through and the chain reverts is a broken agent; an action the SDK blocks but the
chain would have allowed is a limit nobody is really enforcing.

## Honest limitations

- Proves the spec we wrote, not "the system is safe".
- SMTChecker may return `unknown`; we report `UNPROVEN` rather than claiming
  success.
- The hook is fuzzed, not proven.
- Day-boundary behaviour (T6) is a known accepted property, not a bug.
