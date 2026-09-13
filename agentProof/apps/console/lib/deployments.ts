/**
 * The deployed system, as data.
 *
 * Addresses come from `deployments/*.json` — the same files the SDK and API
 * read — rather than being retyped here, so a redeploy cannot leave the UI
 * quietly pointing at a dead contract. Everything else on a node (what it is,
 * what it guarantees, what it cannot do) is editorial and lives here.
 */
import sepolia from '../../../deployments/sepolia.json';
import ensv2 from '../../../deployments/ensv2-sepolia.json';
import hedera from '../../../deployments/hedera-testnet.json';
import proofSummary from '../../../proofs/summary.json';

export const SEPOLIA_EXPLORER = 'https://sepolia.etherscan.io';
export const HASHSCAN = 'https://hashscan.io/testnet';

/**
 * The live Subgraph Studio query endpoint. Overridable so a redeploy under a
 * new version tag does not need a code change; the default is the version
 * recorded in `.env` as GRAPH_ENDPOINT.
 */
export const GRAPH_ENDPOINT =
  process.env.NEXT_PUBLIC_GRAPH_ENDPOINT ||
  'https://api.studio.thegraph.com/query/1760028/agentproof-agent-history/v0.0.2-live-hook';
export const GRAPH_SUBGRAPH_NAME = 'agentproof-agent-history';

/**
 * The publicly reachable Verification API.
 *
 * Today this is a Cloudflare quick tunnel, which is how the Bazantic gateway
 * reaches a locally-running API. Quick tunnels get a fresh hostname on every
 * restart, so this is read from the environment (`API_PUBLIC_URL` in .env,
 * exposed to the client as NEXT_PUBLIC_API_PUBLIC_URL) and the UI labels it as
 * ephemeral rather than presenting it as stable infrastructure.
 */
export const API_PUBLIC_URL = process.env.NEXT_PUBLIC_API_PUBLIC_URL || undefined;

export type StageId =
  | 'agent'
  | 'decode'
  | 'policy'
  | 'proof'
  | 'hook'
  | 'account'
  | 'ens'
  | 'subgraph'
  | 'x402'
  | 'integrations';

/** Which side of the trust boundary a stage sits on. */
export type Side = 'advisory' | 'enforcing';

export interface Artifact {
  label: string;
  value: string;
  /** An address on a block explorer, a URL, or nothing (plain fact). */
  href?: string;
  mono?: boolean;
}

export interface Stage {
  id: StageId;
  /** Short name on the map node. */
  name: string;
  /**
   * The same thing said without jargon.
   *
   * Nobody outside web3 knows what a "hook" or a "subgraph" is, and a map whose
   * every label is a term of art teaches nothing. Plain language leads; the
   * technical name rides along underneath so the two connect.
   */
  plainName: string;
  /** One sentence a non-technical reader can follow, no terminology. */
  plain: string;
  /** The question a viewer has that this stage answers. */
  question: string;
  /** One sentence: what it does. */
  what: string;
  /** What it can be trusted for — and what it explicitly cannot. */
  guarantee: string;
  limit: string;
  side: Side;
  /** Real, deployed things a viewer can go look at. */
  artifacts: Artifact[];
}

const addr = (a: string) => `${SEPOLIA_EXPLORER}/address/${a}`;

export const STAGES: Stage[] = [
  {
    id: 'agent',
    name: 'Agent',
    plainName: 'The AI',
    plain:
      "Decides what to spend. Can be fooled.",
    question: 'What does the agent want to do?',
    what: 'An LLM reads a price signal and proposes a transaction — a target contract and a blob of calldata.',
    guarantee: 'Nothing. This is the part you are not supposed to trust.',
    limit: 'A prompt injection, a bad model day, or a hostile tool response all produce calldata that looks exactly like a good decision.',
    side: 'advisory',
    artifacts: [
      { label: 'trader', value: 'apps/agents/trader — LangGraph', mono: true },
      { label: 'researcher', value: 'apps/agents/researcher — x402 consumer', mono: true },
      { label: 'identity', value: ensv2.agentSubname, mono: true },
    ],
  },
  {
    id: 'decode',
    name: 'Decode',
    plainName: 'The translator',
    plain:
      "Turns unreadable calldata into a plain sentence.",
    question: 'What does that calldata actually do?',
    what: 'The intent decoder turns raw calldata into a normalized intent: kind, counterparty, and every asset outflow it causes.',
    guarantee: 'Outflow is tagged with provenance — DECLARED, DECODED, or MEASURED — so a policy never silently trusts a number the agent chose.',
    limit: 'A selector it has never seen decodes to UNKNOWN with unbounded outflow. That is deliberate: unknown means blocked, not allowed.',
    side: 'advisory',
    artifacts: [
      { label: 'endpoint', value: 'POST /v1/decode', mono: true },
      { label: 'the trap', value: 'swap exact-out — the real cost is amountInMaximum, not amountOut' },
      { label: 'unlimited approve', value: 'counts as unbounded outflow — always BLOCK' },
    ],
  },
  {
    id: 'policy',
    name: 'Policy',
    plainName: 'The rulebook',
    plain:
      "Compares that sentence to your limits.",
    question: 'Is it allowed?',
    what: 'The policy engine checks the decoded intent against the agent’s published limits and returns ALLOW, BLOCK, or REQUIRE_APPROVAL.',
    guarantee: 'Every rule that fired is returned with its observed value and its limit, so a verdict is auditable rather than asserted.',
    limit: 'Advisory. An agent that never calls this API is not stopped by it — that is what the hook is for.',
    side: 'advisory',
    artifacts: [
      { label: 'endpoint', value: 'POST /v1/verify', mono: true },
      { label: 'policy hash', value: 'published to ENS; compared against local on every read' },
    ],
  },
  {
    id: 'proof',
    name: 'Proof',
    plainName: 'The math check',
    plain:
      "Proves the limits are written correctly.",
    question: 'Is the rule itself correct, not just implemented?',
    what: 'solc’s SMTChecker proves MAX_TRANSFER and DAILY_SPEND hold over PolicyLib for all inputs — not for the cases a test happened to pick.',
    guarantee: `${proofSummary.properties.filter((p) => p.status === 'PROVEN').length}/${proofSummary.properties.length} properties PROVEN in ${proofSummary.solverTimeMs} ms. A deliberately broken spec (PolicySpecBroken) produces a counterexample, which is how we know the prover is actually looking.`,
    limit: 'PolicyLib is proven. The hook that calls it is fuzzed and invariant-tested, not proven — the proof table says which is which, and absent artifacts report NOT_RUN rather than passing silently.',
    side: 'advisory',
    artifacts: proofSummary.properties.map((p) => ({
      label: p.property,
      value: `${p.status} · ${p.tool}`,
      mono: true,
    })).concat([
      { label: 'negative control', value: 'PolicySpecBroken — counterexample produced', mono: false },
      { label: 'generated', value: proofSummary.generatedAt, mono: true },
    ]),
  },
  {
    id: 'hook',
    name: 'Hook',
    plainName: 'The lock',
    plain:
      "Refuses oversized transactions on-chain. Cannot be bypassed.",
    question: 'What if the agent skips the SDK entirely?',
    what: 'An ERC-7579 hook installed on the smart account. Every execution passes through it on-chain, whether or not anything off-chain was consulted.',
    guarantee: 'This is the boundary. Sign an oversized transfer directly with the session key and the account reverts with ExceedsMaxTransaction. No SDK, no API, no cooperation required.',
    limit: 'It enforces the limits that are installed on it. Changing those limits is an owner action, not an agent one.',
    side: 'enforcing',
    artifacts: [
      { label: 'AgentPolicyHook', value: sepolia.agentPolicyHook, href: addr(sepolia.agentPolicyHook), mono: true },
      { label: 'revert', value: 'ExceedsMaxTransaction', mono: true },
      { label: 'deployed at block', value: String(sepolia.deployedAtBlock), mono: true },
    ],
  },
  {
    id: 'account',
    name: 'Account',
    plainName: 'The wallet',
    plain:
      "Holds the money. You own it, not the AI.",
    question: 'Whose money is this?',
    what: 'An ERC-7579 smart account (MSAAdvanced) owned by a human, with a session key delegated to the agent and the policy hook installed.',
    guarantee: 'The agent holds a session key, never the owner key. Its authority is exactly what the installed modules permit.',
    limit: 'A session key with no hook installed is just a key. Installation is the security event.',
    side: 'enforcing',
    artifacts: [
      { label: 'smart account', value: sepolia.smartAccount, href: addr(sepolia.smartAccount), mono: true },
      { label: 'implementation', value: `${sepolia.accountImplementation.name} v${sepolia.accountImplementation.version}` },
      { label: 'EntryPoint', value: `${sepolia.accountImplementation.entryPoint} (${sepolia.accountImplementation.entryPointVersion})`, href: addr(sepolia.accountImplementation.entryPoint), mono: true },
      { label: 'factory', value: sepolia.accountImplementation.factory, href: addr(sepolia.accountImplementation.factory), mono: true },
    ],
  },
  {
    id: 'ens',
    name: 'ENS identity',
    plainName: 'The public rulebook',
    plain:
      "Your limits, published publicly for anyone to check.",
    question: 'Who decides what is allowed, and can they lie about it?',
    what: 'The agent has an ENSv2 subname carrying three text records: its policy, its hook, and its status. The policy is published, not asserted at request time.',
    guarantee: 'Anyone can resolve the name and hash the policy themselves. The API reports whether the published hash matches the policy it is actually enforcing.',
    limit: 'ENSv2 contracts are beta. Exact addresses are pinned in deployments/ensv2-sepolia.json so an upstream break is diagnosable rather than mysterious.',
    side: 'enforcing',
    artifacts: [
      { label: 'agent name', value: ensv2.agentSubname, mono: true },
      { label: 'registrar', value: ensv2.agentSubnameRegistrar, href: addr(ensv2.agentSubnameRegistrar), mono: true },
      { label: 'registry', value: ensv2.permissionedRegistry, href: addr(ensv2.permissionedRegistry), mono: true },
      { label: 'resolver', value: ensv2.namespaceResolver, href: addr(ensv2.namespaceResolver), mono: true },
      ...ensv2.textRecords.map((r) => ({ label: 'text record', value: r, mono: true })),
    ],
  },
  {
    id: 'subgraph',
    name: 'Subgraph',
    plainName: 'The receipts',
    plain:
      "Public record of everything that got through.",
    question: 'What actually happened, according to the chain?',
    what: 'A Graph subgraph indexing the hook’s own events — PolicyInstalled, SpendRecorded, TargetAllowed — from the block it was deployed at.',
    guarantee: 'History reflects what the chain admitted, not what any agent intended. Daily spend read here is reconciled against a direct on-chain read.',
    limit: 'Indexing lags the head. When the two sources disagree, the API reports reconciled:false rather than picking a winner.',
    side: 'enforcing',
    artifacts: [
      { label: 'indexed contract', value: sepolia.agentPolicyHook, href: addr(sepolia.agentPolicyHook), mono: true },
      { label: 'start block', value: String(sepolia.deployedAtBlock), mono: true },
      { label: 'events', value: 'PolicyInstalled · SpendRecorded · TargetAllowed · PolicyUninstalled', mono: true },
      { label: 'entities', value: 'Agent · PolicyInstall · Execution · DailyAggregate · TargetPermission' },
      { label: 'live endpoint', value: GRAPH_ENDPOINT, href: GRAPH_ENDPOINT, mono: true },
      { label: 'studio subgraph', value: `${GRAPH_SUBGRAPH_NAME} · v0.0.2-live-hook`, mono: true },
    ],
  },
  {
    id: 'x402',
    name: 'Payment + audit',
    plainName: 'The meter',
    plain:
      "Pay-per-check, logged to an independent ledger.",
    question: 'Who paid for the verification, and is there a record?',
    what: 'The verification API is x402-gated: callers pay per request, settled through a facilitator, with each settlement written to a Hedera Consensus Service topic.',
    guarantee: 'The audit topic is append-only and independent of this service. A verification that was paid for leaves a record nobody here controls.',
    limit: 'Testnet, dust pricing. The point is the settlement path exists end to end, not the amounts.',
    side: 'enforcing',
    artifacts: [
      { label: 'facilitator', value: hedera.facilitator, href: hedera.facilitatorUrl },
      { label: 'network', value: hedera.network, mono: true },
      { label: 'HCS audit topic', value: hedera.hcsAuditTopicId, href: `${HASHSCAN}/topic/${hedera.hcsAuditTopicId}`, mono: true },
      { label: 'service account', value: hedera.serviceAccountId, href: `${HASHSCAN}/account/${hedera.serviceAccountId}`, mono: true },
      ...hedera.settlements.map((s) => ({ label: 'settlement', value: s, mono: true })),
    ],
  },
  {
    id: 'integrations',
    name: 'Integrations',
    plainName: "Other people’s apps",
    plain:
      "Other apps run the same check over HTTP.",
    question: 'Can something that is not ours use this?',
    what: 'The verification path is plain HTTP with no internal imports, so a third-party gateway can chain quote → /v1/decode → /v1/verify → execute-or-stop.',
    guarantee: 'Failing to *obtain* a verification stops the swap exactly like a BLOCK does. A caller cannot fail open by losing the network.',
    limit:
      'Running against a Cloudflare quick tunnel in front of a local API. That hostname changes on every restart, so the integration is live but not durable — a hosted API is what makes it permanent.',
    side: 'advisory',
    artifacts: [
      { label: 'gateway', value: 'Bazantic — verify before you swap' },
      {
        label: 'public API',
        value: API_PUBLIC_URL ?? 'not exposed — set API_PUBLIC_URL',
        href: API_PUBLIC_URL,
        mono: true,
      },
      { label: 'exposed via', value: 'Cloudflare quick tunnel (ephemeral hostname)' },
      { label: 'recipe', value: 'recipes/verify-before-you-swap.ts', mono: true },
      { label: 'run it', value: 'pnpm recipe:verify-before-you-swap', mono: true },
      { label: 'docs', value: 'docs/integrations/bazantic.md', mono: true },
    ],
  },
];

export const STAGE_BY_ID = Object.fromEntries(STAGES.map((s) => [s.id, s])) as Record<StageId, Stage>;

/** The left-to-right spine of the map. Side nodes hang off it. */
export const PIPELINE: StageId[] = ['agent', 'decode', 'policy', 'hook', 'subgraph'];
export const SATELLITES: Record<string, StageId[]> = {
  agent: ['integrations'],
  policy: ['proof'],
  hook: ['account', 'ens'],
  subgraph: ['x402'],
};

export const CHAIN = { id: sepolia.chainId, name: sepolia.network };
