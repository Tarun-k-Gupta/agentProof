import type { Address, Hex, NormalizedIntent } from '../core/types.ts';
import type { ChainReader, Executor, Logger, UserOperationRequest } from '../ports/index.ts';
import { keccak256 } from '../crypto/keccak.ts';

/**
 * The bridge between an ALLOW decision and the chain.
 *
 * Note what this class does NOT do: it does not decide anything. By the time a
 * request reaches `execute`, the policy engine has already ruled, and the hook
 * installed on the account will rule again independently. This layer exists to
 * submit and to report, and keeping it decision-free is what stops the
 * enforcement story from acquiring a third, undocumented opinion.
 */
export class HookEnforcer {
  constructor(
    private readonly options: {
      account: Address;
      hook: Address;
      executor: Executor;
      chain?: ChainReader;
      logger?: Logger;
    },
  ) {}

  async execute(intent: NormalizedIntent): Promise<Hex> {
    const request: UserOperationRequest = {
      account: this.options.account,
      to: intent.raw.to,
      data: intent.raw.data,
      value: intent.raw.value,
    };
    this.options.logger?.log('debug', 'submitting user operation', {
      account: this.options.account,
      target: intent.target,
      kind: intent.kind,
    });
    return this.options.executor.send(request);
  }

  async executeWithOwnerApproval(intent: NormalizedIntent, signature: Hex): Promise<Hex> {
    if (!this.options.executor.sendAsOwner) {
      throw new Error(
        'This executor cannot submit under the owner validator. Human approval requires an ' +
          'owner-capable executor — the agent session key must not be able to raise its own ceiling.',
      );
    }
    return this.options.executor.sendAsOwner(
      {
        account: this.options.account,
        to: intent.raw.to,
        data: intent.raw.data,
        value: intent.raw.value,
      },
      signature,
    );
  }

  /**
   * Third leg of the policy-hash binding: asserts the hash stored in the hook
   * matches the local policy. Called at startup, alongside the ENS check.
   */
  async assertInstalledPolicyHash(expected: Hex): Promise<void> {
    const chain = this.options.chain;
    if (!chain) return;

    const data = `${CONFIG_SELECTOR}${this.options.account.slice(2).toLowerCase().padStart(64, '0')}` as Hex;
    const raw = await chain.call(this.options.hook, data);

    // Config: (address asset, uint256 maxTransaction, uint256 dailyLimit,
    //          uint256 minBalance, bytes32 policyHash, bool installed)
    if (raw.length < 2 + 64 * 6) {
      throw new Error(`Hook at ${this.options.hook} returned no config for ${this.options.account}`);
    }
    const installed = BigInt(`0x${raw.slice(2 + 64 * 5, 2 + 64 * 6)}`) === 1n;
    if (!installed) {
      throw new Error(
        `AgentPolicyHook is not installed on ${this.options.account}. The SDK will not run against an ` +
          'account with no enforcement layer — that would be advice with nothing behind it.',
      );
    }

    const onchain = `0x${raw.slice(2 + 64 * 4, 2 + 64 * 5)}`.toLowerCase();
    if (onchain !== expected.toLowerCase()) {
      throw new PolicyBindingError('hook', expected, onchain as Hex);
    }
  }
}

export class PolicyBindingError extends Error {
  constructor(source: 'ens' | 'hook', expected: Hex, actual: Hex) {
    super(
      `Policy hash published by the ${source} does not match the local policy file.\n` +
        `  local:  ${expected}\n` +
        `  ${source.padEnd(6)}: ${actual}\n` +
        'Refusing to start. One of these has been edited without the others, and until you know ' +
        'which, the limits this agent runs under are unknown.',
    );
    this.name = 'PolicyBindingError';
  }
}

const CONFIG_SELECTOR = keccak256('config(address)').slice(0, 10);
