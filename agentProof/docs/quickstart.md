# Quickstart

## Requirements

- Node 22.6 or later
- pnpm 9
- Optional: Foundry (contracts), solc 0.8.28 + z3 (formal verification)

## Run the demo, offline

```bash
pnpm install
pnpm demo
```

No keys, no RPC, no deployed contracts. The demo runs against `SimulatedAccount`,
a faithful in-process model of the ERC-7579 account and the hook. Step 9 —
bypassing the SDK — reverts for real, because the revert comes from the model's
enforcement path rather than from a check we chose to skip.

## Run the tests

```bash
pnpm test                  # 61 tests
pnpm --filter @agentproof/sdk test
```

Includes the differential fuzz suite: 4,000 randomised spend sequences comparing
the TypeScript policy engine against the on-chain enforcement semantics, asserting
they never disagree on ALLOW/BLOCK.

## Contracts

```bash
forge test --root contracts -vvv
FOUNDRY_PROFILE=deep forge test --root contracts --match-path 'test/invariant/*'
```

The test worth reading first is
`test_RejectsExecutionThatBypassesTheSdkEntirely`.

## Formal verification

```bash
pip install solc-select z3-solver
solc-select install 0.8.28 && solc-select use 0.8.28
pnpm verify:formal
```

Writes `proofs/*.json`. Until you run this, the SDK reports `NOT_RUN` — it never
claims a proof it does not have.

## Deploy to Sepolia

```bash
cp .env.example .env      # fill in RPC, keys, addresses
forge script script/Deploy.s.sol:Deploy --root contracts \
  --rpc-url $SEPOLIA_RPC_URL --broadcast --verify
```

Installing the hook on the account is a separate step, because it must be signed
by the owner key — which never belongs in a deploy script's environment.

`deployments/sepolia.json` is written by the deploy script and read by the SDK,
the API and the dashboard. No address is hardcoded in two places.

## Run the Verification API

```bash
pnpm api                  # http://localhost:8402
curl localhost:8402/health
```

x402 gating is off unless `X402_ENABLED=true`. When it is on, the server verifies
the facilitator advertises our network at `/supported` before accepting traffic,
and refuses to start otherwise — serving 402 challenges that cannot be settled
looks exactly like a working integration until the moment it is demonstrated.

## Writing a policy

```json
{
  "version": "agentproof/v1",
  "agent": "trader.agentproof.eth",
  "chainId": 11155111,
  "asset": { "address": "0x…USDC", "decimals": 6 },
  "policies": {
    "maxTransaction": "100",
    "dailySpend": "500",
    "approvalThreshold": "100",
    "minBalance": "10",
    "allowedContracts": ["0x…UniversalRouter"],
    "allowedRecipients": ["0x…serviceTreasury"]
  },
  "enforcement": { "hook": "0x…", "account": "0x…" }
}
```

Amounts are decimal strings in display units — `"100"` is 100 USDC. The SDK
parses them to base units without going through a float. Never write `100n` for
100 USDC anywhere in the codebase; use `usdc(100)`.

Validation is strict and fails loudly. A daily limit below the per-transaction
limit, an approval threshold no action could reach, or an empty allowlist are all
rejected at startup rather than silently producing an agent that can do nothing
or everything.
