import type { Address, Hex } from '../core/types.ts';
import type { ChainReader, Executor, UserOperationRequest } from '../ports/index.ts';
import { keccak256 } from '../crypto/keccak.ts';
import { normalizeAddress, readAddress, readWord, selectorOf } from '../utils/hex.ts';
import { createDefaultRegistry } from '../decode/index.ts';

/**
 * A faithful in-process model of the ERC-7579 account plus AgentPolicyHook.
 *
 * This is not a stub that returns success. It re-implements the hook's exact
 * semantics — allowlist in preCheck, MEASURED balance delta in postCheck,
 * PolicyLib.applySpend, UTC-day reset, minBalance floor — so that three things
 * become possible without a chain:
 *
 *   1. The demo's key moment runs offline. `sendUnchecked` bypasses the SDK
 *      entirely and still reverts, because the revert comes from here, not from
 *      a policy check we chose to skip.
 *   2. The differential suite can fuzz the TypeScript engine against these
 *      semantics and assert the two never disagree.
 *   3. CI has no network dependency.
 *
 * It is a model, and models are wrong in ways the thing they model is not. The
 * Foundry suite runs the same scenarios against the real Solidity, and the
 * README says which claims rest on which.
 */

export class PolicyRevert extends Error {
  constructor(
    readonly code: 'ExceedsMaxTransaction' | 'ExceedsDailyLimit' | 'TargetNotAllowed' | 'BelowMinBalance',
    readonly detail: Record<string, string>,
  ) {
    super(`${code}(${Object.entries(detail).map(([k, v]) => `${k}=${v}`).join(', ')})`);
    this.name = 'PolicyRevert';
  }
}

export interface SimulatedConfig {
  asset: Address;
  maxTransaction: bigint;
  dailyLimit: bigint;
  minBalance: bigint;
  policyHash: Hex;
  allowedTargets: readonly Address[];
}

const SELECTOR_TRANSFER = '0xa9059cbb';
const SELECTOR_APPROVE = '0x095ea7b3';
const SELECTOR_TRANSFER_FROM = '0x23b872dd';

const SIMULATED_DECODERS = createDefaultRegistry();

export class SimulatedAccount implements Executor, ChainReader {
  readonly chainId: number;
  private balance: bigint;
  private window: { day: number; spent: bigint } = { day: 0, spent: 0n };
  private nonce = 0;
  private clockMs: number;
  private readonly allowed: Set<Address>;

  /** Every execution, in order, for the demo transcript. */
  readonly log: Array<{ txHash: Hex; target: Address; outflow: bigint; spentToday: bigint }> = [];

  constructor(
    readonly address: Address,
    private readonly config: SimulatedConfig,
    options: { balance: bigint; chainId?: number; nowMs?: number },
  ) {
    this.balance = options.balance;
    this.chainId = options.chainId ?? 11_155_111;
    this.clockMs = options.nowMs ?? Date.now();
    this.allowed = new Set([...config.allowedTargets, config.asset].map(normalizeAddress));
    this.window.day = this.today();
  }

  // ------------------------------------------------------------- Executor

  /** The SDK's happy path. Identical enforcement to sendUnchecked. */
  async send(request: UserOperationRequest): Promise<Hex> {
    return this.sendUnchecked(request);
  }

  /**
   * Signs and submits with no SDK involvement whatsoever — the demo's shot 7.
   * There is no separate code path here: the hook does not know or care whether
   * a policy engine looked at this first.
   */
  sendUnchecked(request: UserOperationRequest): Hex {
    const target = normalizeAddress(request.to);

    // --- preCheck ---------------------------------------------------------
    if (!this.allowed.has(target)) throw new PolicyRevert('TargetNotAllowed', { target });

    if (target === this.config.asset) {
      const counterparty = this.decodeCounterparty(request.data);
      if (counterparty && !this.allowed.has(counterparty)) {
        throw new PolicyRevert('TargetNotAllowed', { target: counterparty });
      }
    }

    const balanceBefore = this.balance;
    const today = this.today();

    // --- execution --------------------------------------------------------
    const moved = this.applyTransfer(request.data, target);

    // --- postCheck --------------------------------------------------------
    const outflow = balanceBefore > this.balance ? balanceBefore - this.balance : 0n;

    if (outflow > 0n) {
      if (outflow > this.config.maxTransaction) {
        this.balance = balanceBefore; // revert the whole UserOp
        throw new PolicyRevert('ExceedsMaxTransaction', {
          amount: outflow.toString(),
          limit: this.config.maxTransaction.toString(),
        });
      }
      const base = this.window.day === today ? this.window.spent : 0n;
      const wouldBe = base + outflow;
      if (wouldBe > this.config.dailyLimit) {
        this.balance = balanceBefore;
        throw new PolicyRevert('ExceedsDailyLimit', {
          wouldBe: wouldBe.toString(),
          limit: this.config.dailyLimit.toString(),
        });
      }
      this.window = { day: today, spent: wouldBe };
    }

    if (this.balance < this.config.minBalance) {
      const observed = this.balance;
      this.balance = balanceBefore;
      throw new PolicyRevert('BelowMinBalance', {
        balance: observed.toString(),
        minBalance: this.config.minBalance.toString(),
      });
    }

    const txHash = keccak256(`sim:${this.address}:${this.nonce++}:${request.data}`);
    this.log.push({ txHash, target, outflow: moved, spentToday: this.window.spent });
    return txHash;
  }

  async sendAsOwner(request: UserOperationRequest): Promise<Hex> {
    // The owner validator carries a raised per-operation ceiling. The daily
    // accumulator still applies — approval raises one limit, not all of them.
    const previous = this.config.maxTransaction;
    (this.config as { maxTransaction: bigint }).maxTransaction = this.config.dailyLimit;
    try {
      return this.sendUnchecked(request);
    } finally {
      (this.config as { maxTransaction: bigint }).maxTransaction = previous;
    }
  }

  // ----------------------------------------------------------- ChainReader

  async getErc20Balance(asset: Address, account: Address): Promise<bigint> {
    return normalizeAddress(asset) === this.config.asset && normalizeAddress(account) === this.address
      ? this.balance
      : 0n;
  }

  async call(): Promise<Hex> {
    return '0x';
  }

  async getBlockTimestamp(): Promise<number> {
    return Math.floor(this.clockMs / 1000);
  }

  // ----------------------------------------------------------------- state

  get spentToday(): bigint {
    return this.window.day === this.today() ? this.window.spent : 0n;
  }

  get currentBalance(): bigint {
    return this.balance;
  }

  today(): number {
    return Math.floor(this.clockMs / 1000 / 86_400);
  }

  /** Moves the simulated clock, for exercising the UTC-day reset. */
  advance(ms: number): void {
    this.clockMs += ms;
  }

  /**
   * Models the value that actually leaves the account during execution.
   *
   * Two cases, and the second is the one worth reading carefully:
   *
   *   - a direct ERC-20 transfer moves funds itself
   *   - a router call moves funds because the ROUTER pulls them, via an
   *     allowance, partway through its own execution
   *
   * The real hook does not need to know the difference — it reads the balance
   * before and after and subtracts. A simulator has no router to do the pulling,
   * so it has to model that pull, and it does so by decoding the call.
   *
   * That decoding is a modelling shortcut, and it is the one place where this
   * class is weaker than the thing it models: on-chain, a router that pulled
   * MORE than its calldata implied would still be caught, because the delta is
   * measured rather than derived. Here it would not be. The Foundry suite covers
   * that case against the real Solidity, and docs/formal-verification.md says
   * which claims rest on which.
   */
  private applyTransfer(data: Hex, target: Address): bigint {
    if (target !== this.config.asset) return this.applyRouterPull(data, target);
    const selector = selectorOf(data);
    if (selector === SELECTOR_TRANSFER) {
      const amount = readWord(data, 1);
      if (amount > this.balance) throw new Error('ERC20: transfer amount exceeds balance');
      this.balance -= amount;
      return amount;
    }
    if (selector === SELECTOR_TRANSFER_FROM && readAddress(data, 0) === this.address) {
      const amount = readWord(data, 2);
      if (amount > this.balance) throw new Error('ERC20: transfer amount exceeds balance');
      this.balance -= amount;
      return amount;
    }
    // An approve moves nothing now. That is exactly why the hook alone cannot
    // catch "approve now, drain next block", and why the counterparty allowlist
    // above and the SDK's worst-case approval rule both exist.
    return 0n;
  }

  private applyRouterPull(data: Hex, target: Address): bigint {
    const intent = SIMULATED_DECODERS.decode(
      { to: target, data, value: 0n, chainId: this.chainId },
      { account: this.address, trackedAsset: this.config.asset, decimals: 6 },
    );
    if (intent.kind !== 'SWAP') return 0n;

    const pulled = intent.outflow.find((flow) => flow.asset === this.config.asset)?.amount ?? 0n;
    const moved = pulled > this.balance ? this.balance : pulled;
    this.balance -= moved;
    return moved;
  }

  private decodeCounterparty(data: Hex): Address | undefined {
    const selector = selectorOf(data);
    if (selector === SELECTOR_TRANSFER || selector === SELECTOR_APPROVE) return readAddress(data, 0);
    if (selector === SELECTOR_TRANSFER_FROM) return readAddress(data, 1);
    return undefined;
  }
}
