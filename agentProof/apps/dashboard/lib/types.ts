/**
 * The wire shapes the Verification API returns.
 *
 * Hand-written rather than imported from @agentproof/sdk on purpose: the SDK's
 * types use `bigint`, and everything that crosses HTTP is a decimal string. A
 * shared type here would be a lie that typechecks.
 */

export type Decision = 'ALLOW' | 'BLOCK' | 'REQUIRE_APPROVAL';
export type Provenance = 'DECLARED' | 'DECODED' | 'MEASURED';
export type ProofStatus = 'PROVEN' | 'UNPROVEN' | 'COUNTEREXAMPLE' | 'NOT_RUN';

export interface AssetFlow {
  asset: string;
  amount: string;
  provenance: Provenance;
}

export interface NormalizedIntent {
  kind: 'TRANSFER' | 'APPROVE' | 'SWAP' | 'X402_PAYMENT' | 'NATIVE_TRANSFER' | 'UNKNOWN';
  target: string;
  selector: string;
  counterparty?: string;
  nativeValue: string;
  notionalUSDC: string;
  summary: string;
  outflow: AssetFlow[];
}

export interface PolicyRow {
  id: string;
  name: string;
  decision: Decision;
  passed: boolean;
  formallyVerified: boolean;
  reason?: string;
  limit?: string;
  observed?: string;
  provenance?: Provenance;
}

export interface PolicyViolation {
  policy: string;
  limit: string;
  observed: string;
  provenance: Provenance;
  message?: string;
}

export interface ProofReference {
  property: 'MAX_TRANSFER' | 'DAILY_SPEND';
  status: ProofStatus;
  tool: string;
  solverTimeMs: number;
  artifactPath: string;
  counterexample?: string;
}

export interface Verdict {
  decision: Decision;
  reason?: string;
  violations: PolicyViolation[];
  policyRows: PolicyRow[];
  intent: NormalizedIntent;
  proof?: ProofReference;
  txHash?: string;
  enforcement: {
    advisory: boolean;
    note: string;
    hook: string;
    account: string;
    mode: 'simulation' | 'production';
    unevaluatedPolicies: Array<{ policy: string; reason: string }>;
  };
}

export interface Health {
  ok: boolean;
  mode: 'simulation' | 'production';
  policyHash: string;
  agent: string;
  account: string;
  hook: string;
  proofs: Array<{ property: string; status: ProofStatus }>;
  x402: boolean;
  dashboardAuth: boolean;
  dashboardSession: boolean;
}

export interface Spend {
  account: string;
  dayUtc: number;
  spentGraph: string;
  spentOnchain: string | null;
  reconciled: boolean | null;
  limit: string;
  remaining: string;
}

export interface ApprovalRequest {
  id: string;
  reason: string;
  intent: NormalizedIntent;
  /** ms since epoch when this request stops being actionable */
  expiresAt?: number;
}

/** A line of the agent's own reasoning, streamed from the agent process. */
export interface Thought {
  at: number;
  text: string;
  agent?: string;
}

export type StreamEvent =
  | { type: 'decision'; data: Verdict }
  | { type: 'thought'; data: string | Thought }
  | { type: 'approval'; data: ApprovalRequest };
