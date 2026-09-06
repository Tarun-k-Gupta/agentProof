import {
  EoaExecutor,
  JsonRpcChainReader,
  createViemSigner,
  encodeErc7579Execute,
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
  agentSessionKey: Hex;
  account: Address;
  ownerKey?: Hex;
  chainId: number;
}

/** Reads and validates live configuration. Returns null when incomplete. */
export function readLiveConfig(logger?: Logger): LiveConfig | null {
  if (process.env.AGENTPROOF_LIVE !== 'true') return null;

  const missing = ['SEPOLIA_RPC_URL', 'AGENT_SESSION_KEY', 'SMART_ACCOUNT_ADDRESS'].filter(
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

  const agentSigner = await createViemSigner({
    privateKey: config.agentSessionKey,
    rpcUrl: config.rpcUrl,
    chainId: config.chainId,
  });

  const ownerSigner = config.ownerKey
    ? await createViemSigner({ privateKey: config.ownerKey, rpcUrl: config.rpcUrl, chainId: config.chainId })
    : undefined;

  const executor = new EoaExecutor({ account: config.account, agentSigner, ownerSigner, logger });

  return {
    executor,
    chain,

    /**
     * No SDK, no policy engine, no wrapper. Encodes a 7579 execution and sends
     * it straight to the account with the agent's own key.
     *
     * If the hook is doing its job this reverts on chain, and the revert is the
     * demo. If it succeeds, the thesis is wrong and the demo should say so
     * loudly rather than continuing.
     */
    async sendUnchecked(request) {
      const data = encodeErc7579Execute(request.to, request.value, request.data);
      return agentSigner.sendTransaction({ to: config.account, data, value: 0n });
    },

    explorerUrl(txHash) {
      return `https://sepolia.etherscan.io/tx/${txHash}`;
    },
  };
}
