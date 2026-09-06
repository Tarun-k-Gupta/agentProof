/**
 * The SDK's public type surface.
 *
 * `Address` and `Hex` are structural string types rather than imports from a
 * chain library: the core engine has no runtime dependencies, so it can be
 * embedded anywhere (edge runtime, CI, a Python agent's sidecar) without
 * dragging a wallet stack behind it. Chain access lives behind ports/.
 */

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/**
 * Where a number came from, and therefore how much it can be trusted.
 *
 * This is the single most important idea in the codebase. A policy limit is
 * meaningless unless the number it compares against is derived from the
 * transaction itself rather than from whoever is being limited.
 */
export type Provenance =
  /** The agent said so. Never trusted for a decision. */
  | 'DECLARED'
  /** Parsed from calldata by a known-selector decoder. Trusted for allowlisted shapes. */
  | 'DECODED'
  /** Balance delta measured across execution. Authoritative. */
  | 'MEASURED';

export type Decision = 'ALLOW' | 'BLOCK' | 'REQUIRE_APPROVAL';

export const NATIVE_ASSET: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export interface AssetAmount {
  asset: Address;
  /** base units of `asset` */
  amount: bigint;
  provenance: Provenance;
}

/** What an agent proposes. An intent, not a signed transaction. */
export interface Action {
  to: Address;
  data: Hex;
  /** Native wei ONLY. Never a token amount. */
  value: bigint;
  chainId: number;
  metadata?: Record<string, unknown>;
}

export type IntentKind = 'TRANSFER' | 'APPROVE' | 'SWAP' | 'X402_PAYMENT' | 'NATIVE_TRANSFER' | 'UNKNOWN';

/** The SDK's internal, decoder-produced view of an action. */
export interface NormalizedIntent {
  kind: IntentKind;
  /** contract being called */
  target: Address;
  /** first 4 bytes of calldata */
  selector: Hex;
  /** wei attached to the call */
  nativeValue: bigint;
  /** what leaves the account, worst case */
  outflow: AssetAmount[];
  /** recipient / spender / swap router */
  counterparty?: Address;
  /** canonical 6-decimal figure every policy compares against */
  notionalUSDC: bigint;
  /** human-readable summary, safe to show on a hardware wallet screen */
  summary: string;
  raw: Action;
}

export interface PolicyViolation {
  /** policy id, e.g. 'maxTransaction' */
  policy: string;
  limit: bigint;
  observed: bigint;
  provenance: Provenance;
  message: string;
}

export interface ProofReference {
  property: 'MAX_TRANSFER' | 'DAILY_SPEND';
  status: 'PROVEN' | 'UNPROVEN' | 'COUNTEREXAMPLE' | 'NOT_RUN';
  tool: 'solc-smtchecker' | 'certora';
  solverTimeMs: number;
  artifactPath: string;
  counterexample?: string;
}

export interface ApprovalRequest {
  id: string;
  intent: NormalizedIntent;
  reason: string;
  /** the limit that triggered the request */
  threshold: bigint;
  expiresAt: number;
}

export interface ApprovalOutcome {
  approved: boolean;
  signature?: Hex;
  /** who approved: 'ledger:0x…', 'dashboard:owner', 'console' */
  by: string;
}

export interface PolicyResult {
  decision: Decision;
  /** human-readable, shown in the dashboard and the terminal */
  reason: string;
  intent: NormalizedIntent;
  violations: PolicyViolation[];
  proof?: ProofReference;
  approvalRequest?: ApprovalRequest;
  /** present when decision === 'ALLOW' and the action was executed */
  txHash?: Hex;
  /** monotonic decision counter, for dashboard ordering */
  sequence: number;
  evaluatedAt: number;
}

/** Everything a policy needs to decide, gathered once per evaluation. */
export interface PolicyState {
  account: Address;
  dayUtc: number;
  dailySpend: bigint;
  balance: bigint;
  asset: Address;
  now: number;
}

export interface Policy {
  /** stable id used in violations and dashboard rows */
  readonly id: string;
  /** true when a formal proof covers this policy's arithmetic */
  readonly formallyVerified: boolean;
  evaluate(intent: NormalizedIntent, state: PolicyState): PolicyEvaluation;
}

export interface PolicyEvaluation {
  decision: Decision;
  violation?: PolicyViolation;
  reason?: string;
}

// ---------------------------------------------------------------- policy file

export interface PolicyDocument {
  version: 'agentproof/v1';
  agent: string;
  chainId: number;
  asset: { address: Address; decimals: number };
  policies: {
    maxTransaction: string;
    dailySpend: string;
    approvalThreshold: string;
    minBalance: string;
    allowedContracts: Address[];
    allowedRecipients: Address[];
  };
  enforcement: { hook: Address; account: Address };
}

/** The parsed, bigint-typed form the engine actually uses. */
export interface ResolvedPolicy {
  document: PolicyDocument;
  hash: Hex;
  maxTransaction: bigint;
  dailySpend: bigint;
  approvalThreshold: bigint;
  minBalance: bigint;
  allowedContracts: ReadonlySet<Address>;
  allowedRecipients: ReadonlySet<Address>;
  asset: Address;
  decimals: number;
  account: Address;
  hook: Address;
}
