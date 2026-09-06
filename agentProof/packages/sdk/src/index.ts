/**
 * @agentproof/sdk
 *
 * A safety runtime for autonomous agents. Trust the agent to decide; don't
 * trust it to enforce its own limits.
 *
 * The core has zero runtime dependencies. Chains, indexers, hardware wallets
 * and HTTP all enter through ports/, so the policy engine runs in a browser, an
 * edge function, a CI job or a Python agent's sidecar without a wallet stack.
 */

export { createAgentProof, AgentProof } from './core/AgentProof.ts';
export type { AgentProofConfig, ProtectedAccount } from './core/AgentProof.ts';

export { PolicyEngine } from './core/PolicyEngine.ts';
export type { PolicyEngineOptions } from './core/PolicyEngine.ts';

export { definePolicy, resolvePolicy, policyHash, canonicalJSON, PolicyValidationError } from './core/policy.ts';
export { usdc, parsePolicyAmount, formatUsdc, displayUsdc, utcDay } from './utils/units.ts';

export {
  MaxTransactionPolicy,
  DailySpendPolicy,
  AllowlistPolicy,
  MinBalancePolicy,
  ApprovalThresholdPolicy,
} from './policies/index.ts';

export {
  DecoderRegistry,
  createDefaultRegistry,
  erc20Decoder,
  nativeDecoder,
  uniswapV4Decoder,
  x402Decoder,
  x402PaymentAction,
} from './decode/index.ts';

export { ENSIdentity, ENS_KEY_POLICY, ENS_KEY_HOOK, ENS_KEY_STATUS, namehash, dnsEncode } from './identity/ENSIdentity.ts';
export { MemoryStateProvider } from './state/MemoryStateProvider.ts';
export { GraphStateProvider, StateUnavailableError } from './state/GraphStateProvider.ts';
export { ConsoleApprover, DashboardApprover, LedgerApprover } from './approval/index.ts';
export type { LedgerTransport } from './approval/index.ts';
export { ProofRegistry } from './proofs/ProofRegistry.ts';
export { HookEnforcer, PolicyBindingError } from './enforcement/HookEnforcer.ts';
export { ConsoleLogger, silentLogger } from './utils/logger.ts';
export { keccak256 } from './crypto/keccak.ts';

export {
  redact,
  truncateAddress,
  bucketAmount,
  CommitmentScheme,
  toPublicAuditRecord,
  approvalScreenText,
} from './privacy/index.ts';
export type { PublicAuditRecord } from './privacy/index.ts';

export { SimulatedAccount, PolicyRevert } from './testing/SimulatedAccount.ts';
export type { SimulatedConfig } from './testing/SimulatedAccount.ts';

export type {
  Action,
  Address,
  ApprovalOutcome,
  ApprovalRequest,
  AssetAmount,
  Decision,
  Hex,
  IntentKind,
  NormalizedIntent,
  Policy,
  PolicyDocument,
  PolicyEvaluation,
  PolicyResult,
  PolicyState,
  PolicyViolation,
  ProofReference,
  Provenance,
  ResolvedPolicy,
} from './core/types.ts';
export { NATIVE_ASSET } from './core/types.ts';

export type {
  Approver,
  ChainReader,
  Clock,
  Executor,
  HttpClient,
  IdentityProvider,
  Logger,
  StateProvider,
  UserOperationRequest,
} from './ports/index.ts';

export {
  encodeErc20Transfer,
  encodeErc20Approve,
  encodeErc20TransferFrom,
  encodeUniversalRouterExecute,
  encodeExactInInput,
  encodeExactOutInput,
  encodeSwapExactIn,
  encodeSwapExactOut,
  encodeErc7579Execute,
  UNLIMITED_APPROVAL,
} from './testing/calldata.ts';
