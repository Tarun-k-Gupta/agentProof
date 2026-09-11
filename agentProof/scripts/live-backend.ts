import {
  BundlerExecutor,
  JsonRpcChainReader,
  ENTRY_POINT_V07,
  type Address,
  type ChainReader,
  type Executor,
  type Hex,
  type Logger,
} from '../packages/sdk/src/index.ts';

/**
 * The live backend: the same demo, against real Sepolia.
 *
 * The interface it satisfies is deliberately identical to SimulatedAccount's,
 * because the argument only holds if nothing about the demo changes when the
 * chain becomes real. Same policy file, same nine steps, same bypass.
 *
 * Enable with AGENTPROOF_LIVE=true. Falls back to the simulator on any missing
 * configuration rather than half-running — a demo that silently degrades to
 * fake transactions is worse than one that says it is simulated.
 *
 * Transport note: the pinned account is a strict ERC-7579 reference
 * implementation (MSAAdvanced), whose `execute` is `onlyEntryPointOrSelf`.
 * A direct EOA call to it reverts with AccountAccessUnauthorized before the
 * hook ever runs, so live traffic goes through the EntryPoint as real
 * UserOperations — exactly like contracts/test/integration/RealAccount.t.sol.
 * The bypass then reverts with the hook's own policy error, not an auth
 * error, which is the whole point of the demo.
 */

export interface LiveBackend {
  executor: Executor;
  chain: ChainReader;
  /** Signs and submits with no policy evaluation. The demo's shot 7. */
  sendUnchecked(request: { to: Address; data: Hex; value: bigint }): Promise<Hex>;
  explorerUrl(txHash: Hex): string;
}

export interface LiveConfig {
  rpcUrl: string;
  bundlerUrl: string;
  agentSessionKey: Hex;
  account: Address;
  ownerKey?: Hex;
  chainId: number;
}

/** Reads and validates live configuration. Returns null when incomplete. */
export function readLiveConfig(logger?: Logger): LiveConfig | null {
  if (process.env.AGENTPROOF_LIVE !== 'true') return null;

  const missing = ['SEPOLIA_RPC_URL', 'BUNDLER_URL', 'AGENT_SESSION_KEY', 'SMART_ACCOUNT_ADDRESS'].filter(
    (key) => !process.env[key],
  );

  if (missing.length > 0) {
    logger?.log('warn', 'AGENTPROOF_LIVE is set but configuration is incomplete', {
      missing,
      note: 'falling back to the in-process simulator',
    });
    return null;
  }

  return {
    rpcUrl: process.env.SEPOLIA_RPC_URL!,
    bundlerUrl: process.env.BUNDLER_URL!,
    agentSessionKey: process.env.AGENT_SESSION_KEY! as Hex,
    account: process.env.SMART_ACCOUNT_ADDRESS!.toLowerCase() as Address,
    ownerKey: process.env.OWNER_PRIVATE_KEY as Hex | undefined,
    chainId: Number(process.env.CHAIN_ID ?? 11155111),
  };
}

export async function createLiveBackend(config: LiveConfig, logger?: Logger): Promise<LiveBackend> {
  const chain = new JsonRpcChainReader({ url: config.rpcUrl, chainId: config.chainId, logger });

  // Fail before the demo starts rather than three steps in.
  await chain.assertChainId();

  // The on-chain session validator accepts the session key's signature; the
  // point of the demo is what the *hook* does, not what the validator does.
  // viem is imported dynamically so sim-only runs never pay for a wallet stack.
  const { privateKeyToAccount } = await import('viem/accounts');
  const sessionAccount = privateKeyToAccount(config.agentSessionKey);

  const executor = new BundlerExecutor({
    account: config.account,
    bundlerUrl: config.bundlerUrl,
    entryPoint: ENTRY_POINT_V07,
    // The account addresses its session validator through the nonce's high
    // bits; without this every UserOp dies with AA24 before reaching the hook.
    validator: '0xaBdBCE84aFd1CCD14a03ef78F55693daeE6052DB',
    chain,
    signUserOpHash: async (hash: Hex) => {
      return (await sessionAccount.signMessage({ message: { raw: hash } })) as Hex;
    },
    logger,
  });

  return {
    executor,
    chain,

    /**
     * No SDK, no policy engine, no wrapper. Submits a UserOperation signed by
     * the agent's own key straight to the bundler.
     *
     * If the hook is doing its job the bundler's estimation (or the account's
     * execution) reverts with the hook's policy error, and the revert is the
     * demo. If it succeeds, the thesis is wrong and the demo should say so
     * loudly rather than continuing.
     */
    async sendUnchecked(request) {
      return executor.sendUnsigned({ account: config.account, ...request });
    },

    explorerUrl(txHash) {
      return `https://sepolia.etherscan.io/tx/${txHash}`;
    },
  };
}
