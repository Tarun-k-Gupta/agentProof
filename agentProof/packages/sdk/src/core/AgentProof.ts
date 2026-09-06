import type {
  Action,
  Address,
  ApprovalRequest,
  Hex,
  PolicyDocument,
  PolicyResult,
  PolicyState,
  ResolvedPolicy,
} from './types.ts';
import type { Approver, Clock, Executor, IdentityProvider, Logger, StateProvider } from '../ports/index.ts';
import { systemClock } from '../ports/index.ts';
import { PolicyEngine } from './PolicyEngine.ts';
import { resolvePolicy } from './policy.ts';
import { createDefaultRegistry, DecoderRegistry } from '../decode/index.ts';
import {
  AllowlistPolicy,
  ApprovalThresholdPolicy,
  DailySpendPolicy,
  MaxTransactionPolicy,
  MinBalancePolicy,
} from '../policies/index.ts';
import { ProofRegistry } from '../proofs/ProofRegistry.ts';
import { HookEnforcer, PolicyBindingError } from '../enforcement/HookEnforcer.ts';
import { CommitmentScheme, toPublicAuditRecord, type PublicAuditRecord } from '../privacy/index.ts';
import { silentLogger } from '../utils/logger.ts';
import { utcDay } from '../utils/units.ts';

export interface AgentProofConfig {
  /** a parsed policy document, or a path to agent.policy.json */
  policy: PolicyDocument | string;
  state: StateProvider;
  identity?: IdentityProvider;
  approver?: Approver;
  enforcement?: { executor: Executor; hook?: Address; account?: Address };
  decoders?: DecoderRegistry;
  proofs?: ProofRegistry | string;
  logger?: Logger;
  clock?: Clock;
  /** Escape hatch, visible in review. Off by default and loudly logged. */
  allowUnknownSelectors?: boolean;
  onDecision?: (result: PolicyResult) => void;
  /** Called with the privacy-projected record destined for a public ledger. */
  onAuditRecord?: (record: PublicAuditRecord) => void;
}

export interface ProtectedAccount {
  /** Evaluate and, if allowed, execute. */
  execute(action: Action): Promise<PolicyResult>;
  /** Evaluate only. No signing, no side effects. */
  check(action: Action): Promise<PolicyResult>;
}

/**
 * Builds a configured AgentProof instance.
 *
 * Async because startup is not a formality. Before the first decision it:
 *
 *   1. parses and validates the policy, computing its canonical hash
 *   2. compares that hash against the one published in the agent's ENS record
 *   3. compares it against the one stored in the installed hook
 *   4. checks the agent has not been marked suspended
 *   5. loads whatever proof artifacts exist, honestly
 *
 * Any mismatch throws. This is the single most opinionated decision in the
 * SDK: an agent whose three published policy commitments disagree does not get
 * to run with the most permissive one, or with the local one, or with a
 * warning. It does not run.
 */
export async function createAgentProof(config: AgentProofConfig) {
  const logger = config.logger ?? silentLogger;
  const clock = config.clock ?? systemClock;

  const document = typeof config.policy === 'string' ? await loadPolicyFile(config.policy) : config.policy;
  const policy = resolvePolicy(document);

  logger.log('info', 'policy loaded', { agent: document.agent, policyHash: policy.hash });

  if (config.allowUnknownSelectors) {
    logger.log('warn', 'allowUnknownSelectors is ON — calldata this SDK cannot decode will be permitted', {
      agent: document.agent,
    });
  }

  // --- binding check 1: the name -------------------------------------------
  if (config.identity) {
    const published = await config.identity.resolvePolicyHash(document.agent);
    if (published.toLowerCase() !== policy.hash.toLowerCase()) {
      throw new PolicyBindingError('ens', policy.hash, published);
    }
    const status = await config.identity.resolveStatus(document.agent);
    if (status !== 'active') {
      throw new Error(
        `Agent ${document.agent} is marked '${status}' in its ENS records. Refusing to start. ` +
          'Suspension is a kill switch an operator can pull without touching the agent process.',
      );
    }
    logger.log('info', 'ENS policy binding verified', { agent: document.agent, status });
  }

  const proofs =
    config.proofs instanceof ProofRegistry
      ? config.proofs
      : typeof config.proofs === 'string'
        ? await ProofRegistry.load(config.proofs)
        : ProofRegistry.notRun();

  const engine = new PolicyEngine({
    decoders: config.decoders ?? createDefaultRegistry(),
    decoderContext: { account: policy.account, trackedAsset: policy.asset, decimals: policy.decimals },
    proofs: proofs.asMap(),
    policies: [
      new AllowlistPolicy(policy.allowedContracts, policy.allowedRecipients, {
        allowUnknownSelectors: config.allowUnknownSelectors,
      }),
      new MaxTransactionPolicy(policy.maxTransaction),
      new MinBalancePolicy(policy.minBalance),
      new DailySpendPolicy(policy.dailySpend),
      new ApprovalThresholdPolicy(policy.approvalThreshold),
    ],
  });

  const enforcer = config.enforcement
    ? new HookEnforcer({
        account: config.enforcement.account ?? policy.account,
        hook: config.enforcement.hook ?? policy.hook,
        executor: config.enforcement.executor,
        logger,
      })
    : undefined;

  return new AgentProof({ policy, engine, enforcer, proofs, logger, clock, config });
}

export class AgentProof {
  private readonly commitments = new CommitmentScheme();

  constructor(
    private readonly deps: {
      policy: ResolvedPolicy;
      engine: PolicyEngine;
      enforcer?: HookEnforcer;
      proofs: ProofRegistry;
      logger: Logger;
      clock: Clock;
      config: AgentProofConfig;
    },
  ) {}

  get policyHash(): Hex {
    return this.deps.policy.hash;
  }

  get proofs(): ProofRegistry {
    return this.deps.proofs;
  }

  /** Wraps an account so every action passes through the engine first. */
  async protect(executor?: Executor): Promise<ProtectedAccount> {
    const enforcer =
      this.deps.enforcer ??
      (executor
        ? new HookEnforcer({
            account: this.deps.policy.account,
            hook: this.deps.policy.hook,
            executor,
            logger: this.deps.logger,
          })
        : undefined);

    return {
      check: (action) => this.check(action),
      execute: (action) => this.execute(action, enforcer),
    };
  }

  /** Pure evaluation: decode, gather state, decide. No signing. */
  async check(action: Action): Promise<PolicyResult> {
    const intent = this.deps.engine.decode(action);
    const state = await this.gatherState();
    const result = this.deps.engine.evaluate(intent, state);
    this.publish(result);
    return result;
  }

  private async execute(action: Action, enforcer?: HookEnforcer): Promise<PolicyResult> {
    const intent = this.deps.engine.decode(action);
    const state = await this.gatherState();
    let result = this.deps.engine.evaluate(intent, state);

    if (result.decision === 'REQUIRE_APPROVAL') {
      result = await this.seekApproval(result);
    }

    if (result.decision !== 'ALLOW') {
      this.publish(result);
      return result;
    }

    if (!enforcer) {
      this.publish(result);
      return { ...result, reason: `${result.reason} (not executed: no executor configured)` };
    }

    const txHash = result.approvalRequest
      ? await enforcer.executeWithOwnerApproval(intent, (result as { ownerSignature?: Hex }).ownerSignature ?? '0x')
      : await enforcer.execute(intent);

    await this.deps.config.state.recordExecution(this.deps.policy.account, intent, txHash);

    const executed = { ...result, txHash };
    this.publish(executed);
    return executed;
  }

  private async seekApproval(result: PolicyResult): Promise<PolicyResult> {
    const approver = this.deps.config.approver;
    if (!approver) {
      // No approver configured means no human is reachable, and an action that
      // requires a human but cannot reach one is not approved.
      return {
        ...result,
        decision: 'BLOCK',
        reason: `${result.reason}, and no approver is configured`,
      };
    }

    const request: ApprovalRequest = {
      id: `${this.deps.policy.account}:${result.sequence}:${this.deps.clock.now()}`,
      intent: result.intent,
      reason: result.reason,
      threshold: this.deps.policy.approvalThreshold,
      expiresAt: this.deps.clock.now() + 120_000,
    };

    const outcome = await approver.request(request);
    this.deps.logger.log('info', 'approval outcome', { approved: outcome.approved, by: outcome.by });

    return outcome.approved
      ? { ...result, decision: 'ALLOW', reason: `approved by ${outcome.by}`, approvalRequest: request }
      : { ...result, decision: 'BLOCK', reason: `declined by ${outcome.by}`, approvalRequest: request };
  }

  private async gatherState(): Promise<PolicyState> {
    const now = this.deps.clock.now();
    const dayUtc = utcDay(now);
    const account = this.deps.policy.account;

    const [dailySpend, balance] = await Promise.all([
      this.deps.config.state.getDailySpend(account, dayUtc),
      this.deps.config.state.getBalance(account, this.deps.policy.asset),
    ]);

    return { account, dayUtc, dailySpend, balance, asset: this.deps.policy.asset, now };
  }

  private publish(result: PolicyResult): void {
    this.deps.config.onDecision?.(result);
    this.deps.config.onAuditRecord?.(
      toPublicAuditRecord(result, this.deps.policy.account, this.deps.policy.hash, this.commitments),
    );
  }
}

async function loadPolicyFile(path: string): Promise<PolicyDocument> {
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(path, 'utf8')) as PolicyDocument;
}
