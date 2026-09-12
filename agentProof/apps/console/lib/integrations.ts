/**
 * The protocols this is actually built on.
 *
 * Written as "what we do with it", not "we use it". A judge reading this should
 * be able to open the named file or address and find the integration, so every
 * `where` is a real path and every `status` is the true state — including the
 * ones that are not fully live.
 */
import sepolia from '../../../deployments/sepolia.json';
import ensv2 from '../../../deployments/ensv2-sepolia.json';
import hedera from '../../../deployments/hedera-testnet.json';
import { API_PUBLIC_URL, GRAPH_ENDPOINT, HASHSCAN, SEPOLIA_EXPLORER } from './deployments';

export type IntegrationStatus = 'live' | 'deployed';

export interface Integration {
  name: string;
  /** The one-line reason this protocol is in the project at all. */
  role: string;
  /** What the integration concretely does — the interesting part. */
  detail: string;
  /** Where in the repo it lives. */
  where: string;
  status: IntegrationStatus;
  statusNote: string;
  links: Array<{ label: string; href: string }>;
}

export const INTEGRATIONS: Integration[] = [
  {
    name: 'Uniswap v4',
    role: 'The trades we have to make safe',
    detail:
      'Decodes a Universal Router command stream into worst-case outflow per currency. Exact-output binds on amountInMaximum, never the quote — reading the quote is how a 250 USDC swap disguises itself as a 1 USDC one. Anything undecodable returns UNBOUNDED rather than a guess.',
    where: 'packages/sdk/src/decode/uniswapV4.ts',
    status: 'live',
    statusNote:
      'Pinned against six real Sepolia transactions in tests/fixtures/uniswap-sepolia.json. The first run decoded all six as UNBOUNDED — self-encoded fixtures had hidden an off-by-one in the action bytes.',
    links: [
      { label: 'Universal Router', href: `${SEPOLIA_EXPLORER}/address/${sepolia.uniswapUniversalRouter}` },
      { label: 'v4 PoolManager', href: `${SEPOLIA_EXPLORER}/address/${sepolia.uniswapV4PoolManager}` },
    ],
  },
  {
    name: 'ENSv2',
    role: 'The agent’s public identity',
    detail:
      'The agent holds the subname trader.agentproof.eth under a permissioned registry, carrying three text records: agentproof.policy, agentproof.hook and agentproof.status. Its limits are published, so anyone can resolve the name and hash the policy themselves rather than trusting what we report.',
    where: 'deployments/ensv2-sepolia.json',
    status: 'live',
    statusNote:
      'Roles are separated down to the record — ROLE_SET_POLICY_RECORD is not ROLE_SET_HOOK_RECORD. ENSv2 is beta, so every contract address is pinned rather than resolved at runtime.',
    links: [
      { label: 'Registrar', href: `${SEPOLIA_EXPLORER}/address/${ensv2.agentSubnameRegistrar}` },
      { label: 'Registry', href: `${SEPOLIA_EXPLORER}/address/${ensv2.permissionedRegistry}` },
      { label: 'Resolver', href: `${SEPOLIA_EXPLORER}/address/${ensv2.namespaceResolver}` },
    ],
  },
  {
    name: 'Hedera',
    role: 'Payment and an audit log we don’t own',
    detail:
      'The Verification API is x402-gated: callers pay per request, settled through the blocky402 facilitator on hedera-testnet, and every settlement is written to a Hedera Consensus Service topic. A verification that was paid for leaves an append-only record on infrastructure we do not control.',
    where: 'packages/api/src/x402/ · packages/x402-client/',
    status: 'live',
    statusNote:
      'Two real paid settlements recorded. The API refuses to start unless the facilitator’s /supported endpoint actually advertises hedera-testnet with scheme=exact.',
    links: [
      { label: 'HCS audit topic', href: `${HASHSCAN}/topic/${hedera.hcsAuditTopicId}` },
      { label: 'Service account', href: `${HASHSCAN}/account/${hedera.serviceAccountId}` },
      { label: 'Facilitator', href: hedera.facilitatorUrl },
    ],
  },
  {
    name: 'The Graph',
    role: 'What the chain actually admitted',
    detail:
      'A subgraph indexing the enforcement hook’s own events — PolicyInstalled, SpendRecorded, TargetAllowed — from block 11684190. The daily-spend policy reads the pre-aggregated DailyAggregate entity, which is what keeps a policy decision fast enough to sit in an agent’s hot path.',
    where: 'subgraphs/agent-history/',
    status: 'live',
    statusNote:
      'Deployed to Subgraph Studio as v0.0.2-live-hook. Spend read from the subgraph is reconciled against a direct on-chain read; when they disagree the API reports reconciled:false rather than picking a winner.',
    links: [{ label: 'Query endpoint', href: GRAPH_ENDPOINT }],
  },
  {
    name: 'Bazantic',
    role: 'Someone else’s app, using our check',
    detail:
      'A gateway recipe that chains quote → /v1/decode → /v1/verify → execute-or-stop over plain HTTP, importing nothing internal. Failing to obtain a verification stops the swap exactly like a BLOCK does, so a caller cannot fail open by losing the network.',
    where: 'recipes/verify-before-you-swap.ts',
    status: 'live',
    statusNote:
      'Runs end to end against the public Verification API — quote, decode, verify, then execute or stop.',
    links: API_PUBLIC_URL ? [{ label: 'Public API', href: API_PUBLIC_URL }] : [],
  },
  {
    name: 'ERC-7579 + ERC-4337',
    role: 'Where the limit physically lives',
    detail:
      'The enforcement hook is an ERC-7579 module installed on an MSAAdvanced smart account, driven through EntryPoint v0.8.0. Every execution passes through the hook on-chain, so an oversized transfer reverts with ExceedsMaxTransaction whether or not our SDK was ever called.',
    where: 'contracts/src/AgentPolicyHook.sol',
    status: 'deployed',
    statusNote:
      'Account-abstraction pinned at v0.8.0 deliberately: v0.7 predates ISenderCreator, and v0.9 gates handleOps behind tx.origin == msg.sender.',
    links: [
      { label: 'AgentPolicyHook', href: `${SEPOLIA_EXPLORER}/address/${sepolia.agentPolicyHook}` },
      { label: 'Smart account', href: `${SEPOLIA_EXPLORER}/address/${sepolia.smartAccount}` },
      { label: 'EntryPoint v0.8.0', href: `${SEPOLIA_EXPLORER}/address/${sepolia.accountImplementation.entryPoint}` },
    ],
  },
  {
    name: 'Ledger',
    role: 'The human in the loop',
    detail:
      'When a proposal escalates to REQUIRE_APPROVAL it routes to a hardware device, which signs the human-readable intent — recipient, asset, amount — never raw calldata.',
    where: 'packages/sdk/src/approval/ledger.ts',
    status: 'live',
    statusNote:
      'With hardware approval enabled and no device reachable, the process refuses to start rather than downgrading to a browser click. Swapping hardware confirmation for a click is a trust-model change, not an error-handler decision.',
    links: [],
  },
  {
    name: 'solc SMTChecker',
    role: 'Proof the rules are right',
    detail:
      'MAX_TRANSFER and DAILY_SPEND are proven over PolicyLib for all inputs, not for the cases a test happened to pick. A deliberately broken spec, PolicySpecBroken, is checked alongside and must produce a counterexample — that is how we know the solver is actually looking.',
    where: 'contracts/formal/ · proofs/',
    status: 'live',
    statusNote:
      'The hook itself is fuzzed and invariant-tested, not proven, and the proof table says so. Missing artifacts report NOT_RUN rather than passing silently.',
    links: [],
  },
];

export const STATUS_COPY: Record<IntegrationStatus, string> = {
  live: 'Live',
  deployed: 'Deployed',
};
