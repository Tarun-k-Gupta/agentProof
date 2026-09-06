import type { Address, Hex } from '../core/types.ts';
import type { Signer } from './executors.ts';

/**
 * A viem-backed signer.
 *
 * viem is imported dynamically and declared as an optional peer dependency, so
 * the SDK core still installs and runs with zero dependencies. You only pay for
 * a wallet stack if you actually sign something.
 */
export async function createViemSigner(options: {
  privateKey: Hex;
  rpcUrl: string;
  chainId?: number;
}): Promise<Signer> {
  let viem: typeof import('viem');
  let accounts: typeof import('viem/accounts');
  let chains: typeof import('viem/chains');

  try {
    viem = await import('viem');
    accounts = await import('viem/accounts');
    chains = await import('viem/chains');
  } catch {
    throw new Error(
      'createViemSigner needs viem installed: pnpm add viem. ' +
        'The policy engine does not require it — only signing does.',
    );
  }

  const account = accounts.privateKeyToAccount(options.privateKey);
  const chain = options.chainId === 1 ? chains.mainnet : chains.sepolia;

  const wallet = viem.createWalletClient({ account, chain, transport: viem.http(options.rpcUrl) });
  const publicClient = viem.createPublicClient({ chain, transport: viem.http(options.rpcUrl) });

  return {
    address: account.address.toLowerCase() as Address,

    async sendTransaction(tx) {
      // Simulate first. A revert here is the hook rejecting the action, and it
      // should surface as a policy error before any gas is spent — not as a
      // failed transaction the user pays for and then has to decode.
      try {
        await publicClient.call({ account, to: tx.to, data: tx.data, value: tx.value });
      } catch (error) {
        throw new Error(`Execution would revert: ${describeRevert(error)}`);
      }

      const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`Transaction ${hash} reverted on chain`);
      return hash as Hex;
    },
  };
}

/**
 * Pulls the custom-error name out of a viem revert.
 *
 * Worth the twenty lines: "ExceedsMaxTransaction" on screen is the demo's
 * payoff, and "execution reverted" is not.
 */
function describeRevert(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const known = [
    'ExceedsMaxTransaction',
    'ExceedsDailyLimit',
    'TargetNotAllowed',
    'BelowMinBalance',
    'UnsupportedCallType',
    'NotInstalled',
  ];
  const matched = known.find((name) => message.includes(name));
  return matched ? `${matched} (AgentPolicyHook)` : message.split('\n')[0];
}
