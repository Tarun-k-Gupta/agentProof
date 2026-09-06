import type { Address, Hex } from '../core/types.ts';
import type { Executor, Logger, UserOperationRequest } from '../ports/index.ts';
import { keccak256 } from '../crypto/keccak.ts';

/**
 * Getting a signed transaction onto Sepolia.
 *
 * Two implementations, and which one you use does not change what is enforced.
 * The hook runs inside the account's execution path either way, so both routes
 * hit `preCheck`/`postCheck`. That is the whole reason this is a hook and not a
 * guard contract: there is no submission path that skips it.
 *
 *   EoaExecutor      owner EOA calls account.execute() directly.  ← default
 *   BundlerExecutor  a real ERC-4337 UserOperation.               ← stretch
 *
 * The default is the EOA path on purpose. Risk R6 in the plan is "the bundler
 * does not support the chosen 7579 account", and the mitigation is to fall back
 * to direct execute calls. Building the fallback first means bundler trouble
 * costs an afternoon of polish rather than the demo.
 */

export interface Signer {
  readonly address: Address;
  /** Signs and broadcasts a transaction; resolves to the transaction hash. */
  sendTransaction(tx: { to: Address; data: Hex; value: bigint }): Promise<Hex>;
}

/**
 * Executes through the account's own `execute(bytes32,bytes)` entrypoint.
 *
 * Every call is wrapped in the ERC-7579 single-call encoding, which is exactly
 * what the hook decodes in `preCheck`. Nothing here is special-cased for
 * AgentProof — this is just how you call a 7579 account.
 */
export class EoaExecutor implements Executor {
  private readonly account: Address;
  private readonly agentSigner: Signer;
  private readonly ownerSigner?: Signer;
  private readonly logger?: Logger;

  constructor(options: { account: Address; agentSigner: Signer; ownerSigner?: Signer; logger?: Logger }) {
    this.account = options.account;
    this.agentSigner = options.agentSigner;
    this.ownerSigner = options.ownerSigner;
    this.logger = options.logger;
  }

  async send(request: UserOperationRequest): Promise<Hex> {
    return this.dispatch(this.agentSigner, request, 'agent');
  }

  /**
   * The escalated path, after a human approved.
   *
   * Note this uses a *different signer*, not a relaxed check. The agent's key
   * cannot produce this transaction at all — approval raises a ceiling by
   * changing who signs, never by softening a rule.
   */
  async sendAsOwner(request: UserOperationRequest): Promise<Hex> {
    if (!this.ownerSigner) {
      throw new Error(
        'No owner signer configured. Human approval requires the owner key, which must not live ' +
          'in the agent process — configure it in the approval service or on a Ledger.',
      );
    }
    return this.dispatch(this.ownerSigner, request, 'owner');
  }

  private async dispatch(signer: Signer, request: UserOperationRequest, role: string): Promise<Hex> {
    const data = encodeErc7579Execute(request.to, request.value, request.data);
    this.logger?.log('debug', 'submitting execution', { role, account: this.account, target: request.to });

    // A revert here is the hook doing its job. Surface it rather than wrapping
    // it in something generic — "ExceedsMaxTransaction" is the demo.
    return signer.sendTransaction({ to: this.account, data, value: 0n });
  }
}

/**
 * A real ERC-4337 UserOperation, signed by the agent session key.
 *
 * Kept minimal: build, sign, send, poll for the receipt. The interesting
 * property for the demo is that `sendUnsigned` exists — it submits a UserOp
 * that never went through the policy engine, so shot 7 can be run against live
 * infrastructure rather than only against the simulator.
 */
export class BundlerExecutor implements Executor {
  private readonly account: Address;
  private readonly bundlerUrl: string;
  private readonly entryPoint: Address;
  private readonly signUserOpHash: (hash: Hex) => Promise<Hex>;
  private readonly logger?: Logger;

  constructor(options: {
    account: Address;
    bundlerUrl: string;
    entryPoint?: Address;
    signUserOpHash: (hash: Hex) => Promise<Hex>;
    logger?: Logger;
  }) {
    this.account = options.account;
    this.bundlerUrl = options.bundlerUrl;
    this.entryPoint = options.entryPoint ?? ENTRY_POINT_V07;
    this.signUserOpHash = options.signUserOpHash;
    this.logger = options.logger;
  }

  async send(request: UserOperationRequest): Promise<Hex> {
    return this.submit(request);
  }

  /**
   * Submits without any policy evaluation having occurred. This is the demo's
   * key moment against real infrastructure: the bundler accepts it, the account
   * executes it, and the hook reverts the whole operation.
   */
  async sendUnsigned(request: UserOperationRequest): Promise<Hex> {
    return this.submit(request);
  }

  private async submit(request: UserOperationRequest): Promise<Hex> {
    const callData = encodeErc7579Execute(request.to, request.value, request.data);

    const nonce = await this.rpc<Hex>('eth_getUserOperationNonce', [this.account, this.entryPoint]).catch(
      () => '0x0' as Hex,
    );

    const userOp: Record<string, string> = {
      sender: this.account,
      nonce,
      callData,
      callGasLimit: '0x186a0',
      verificationGasLimit: '0x186a0',
      preVerificationGas: '0xc350',
      maxFeePerGas: '0x59682f00',
      maxPriorityFeePerGas: '0x3b9aca00',
      signature: '0x',
    };

    const estimated = await this.rpc<Record<string, string>>('eth_estimateUserOperationGas', [
      userOp,
      this.entryPoint,
    ]).catch((error: unknown) => {
      // Estimation reverting IS the hook rejecting the operation. Do not
      // swallow it into a default gas value and submit anyway.
      throw new Error(`UserOperation rejected during estimation: ${describe(error)}`);
    });

    Object.assign(userOp, estimated);

    const hash = await this.rpc<Hex>('eth_getUserOperationHash', [userOp, this.entryPoint]).catch(() =>
      keccak256(JSON.stringify(userOp)),
    );
    userOp.signature = await this.signUserOpHash(hash as Hex);

    const opHash = await this.rpc<Hex>('eth_sendUserOperation', [userOp, this.entryPoint]);
    this.logger?.log('info', 'user operation submitted', { opHash });

    return this.waitForReceipt(opHash);
  }

  private async waitForReceipt(opHash: Hex, attempts = 30): Promise<Hex> {
    for (let i = 0; i < attempts; i++) {
      const receipt = await this.rpc<{ success: boolean; receipt: { transactionHash: Hex }; reason?: string } | null>(
        'eth_getUserOperationReceipt',
        [opHash],
      ).catch(() => null);

      if (receipt) {
        if (!receipt.success) {
          throw new Error(`UserOperation reverted on chain: ${receipt.reason ?? 'no reason returned'}`);
        }
        return receipt.receipt.transactionHash;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`UserOperation ${opHash} was not mined within ${attempts * 2} seconds`);
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetch(this.bundlerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = (await response.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result as T;
  }
}

export const ENTRY_POINT_V07: Address = '0x0000000071727de22e5e9d8baf0edac6f37da032';

const word = (value: bigint | number | string): string => BigInt(value).toString(16).padStart(64, '0');

/** ERC-7579 `execute(bytes32 mode, bytes executionCalldata)`, CALLTYPE_SINGLE. */
export function encodeErc7579Execute(target: Address, value: bigint, callData: Hex): Hex {
  const packed = target.slice(2) + word(value) + callData.slice(2);
  const length = packed.length / 2;
  const padded = packed.padEnd(Math.ceil(length / 32) * 64, '0');
  return `0xe9ae5c53${word(0)}${word(64)}${word(length)}${padded}` as Hex;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
