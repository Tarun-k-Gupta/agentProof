# Bazantic

**Status: environment-gated.** The recipe below runs today against a local or
hosted Verification API. Wiring it into a Bazantic gateway needs a Bazantic
account and a gateway endpoint, neither of which lives in this repository. Where
this document says "configure", it means configuration you supply — nothing here
is stubbed out and pretending to work.

## What AgentProof offers a gateway

One tool, with one honest limitation.

The tool is **verify before you swap**: given router calldata an agent is about
to send, return what it would cost at worst and whether the owner's policy
permits it. The limitation is that this is *advisory*. An HTTP endpoint that
answers "is this safe?" is, on its own, exactly the bypassable
application-layer guardrail this project argues against — an agent that decides
not to call it is not stopped by it.

The boundary is the ERC-7579 hook installed on the account. The gateway tool is
the layer for agents that cannot embed the SDK, and every response says so in
its `enforcement` block. Read that block; do not strip it.

## The recipe

`recipes/verify-before-you-swap.ts`, runnable now:

```bash
pnpm api                                # terminal 1
pnpm recipe:verify-before-you-swap      # terminal 2
```

It runs against a real Sepolia Universal Router transaction from the decoder's
fixture set and executes nothing — the execute step is a stub that reports what
would have been sent.

Four steps:

| Step | What happens | Who owns it |
|---|---|---|
| 1. quote | a router produces calldata | the gateway, or the Uniswap SDK |
| 2. decode | `POST /v1/decode` → worst-case outflow per asset | AgentProof |
| 3. verify | `POST /v1/verify` → ALLOW / BLOCK / REQUIRE_APPROVAL | AgentProof |
| 4. execute or stop | send it, escalate it, or refuse | the gateway |

Step 4 is the one that matters. `BLOCK` stops. `REQUIRE_APPROVAL` stops unless
the caller's own approval flow returns true. And a verification that could not
be obtained at all — API down, payment rejected, request timed out — also stops.
An agent that cannot get an answer has not got a yes.

## Gateway configuration

```jsonc
{
  "tools": [
    {
      "name": "agentproof.verify",
      "endpoint": "${AGENTPROOF_API_URL}/v1/verify",
      "method": "POST",
      // The API is x402-priced. See docs/integrations/hedera.md for obtaining a
      // payment payload; without one the endpoint answers 402, not 200.
      "headers": { "X-PAYMENT": "${X_PAYMENT}" },
      "timeoutMs": 10000,
      "onError": "stop"        // never "continue"
    },
    {
      "name": "agentproof.decode",
      "endpoint": "${AGENTPROOF_API_URL}/v1/decode",
      "method": "POST",
      "timeoutMs": 10000,
      "onError": "stop"
    }
  ]
}
```

Environment:

| Variable | Meaning |
|---|---|
| `AGENTPROOF_API_URL` | the Verification API base URL |
| `AGENT_NAME` | the ENS name whose policy applies, e.g. `trader.agentproof.eth` |
| `X_PAYMENT` | an x402 payload; see `packages/x402-client` |
| `TOKEN_RISK_API_URL` | optional, see below |

`onError: "stop"` is not a preference. A gateway configured to continue past a
failed verification has an agent that spends freely exactly when the safety
layer is broken, which is the worst possible time.

## Token risk metadata

Optional, off by default, and deliberately **not** a new policy type.

A risk score is a third party's opinion. Turning an opinion into an autonomous
block invents a policy the owner never wrote — and, worse, makes the agent's
spending authority depend on an API the owner does not control. What the adapter
does instead is annotate the counterparty, so:

- the owner sees the labels on the approval screen, next to the amount;
- a gateway that chooses to can feed them into the **existing allowlist**
  decision, which the owner does control.

If the risk API is unreachable, the annotation is absent and the policy decision
is unchanged. A risk service being down is not a reason to block, and it is not
a reason to proceed either.

## Prerequisites this repository cannot satisfy

- a Bazantic account and gateway endpoint;
- a publicly reachable Verification API (the recipe defaults to
  `http://localhost:8402`, which a hosted gateway cannot see);
- a funded Hedera account, if the API is priced.

Until those exist, treat the Bazantic integration as *demonstrated locally,
not qualified*. `docs/future-work.md` lists it under the same heading.
