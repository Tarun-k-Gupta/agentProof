/**
 * Installs AgentPolicyHook on the live account with the final policy hash.
 *
 * The hook carries keccak256(canonical agent.policy.json), which covers the
 * account address itself — so it cannot be part of the counterfactual
 * initCode and is installed here, afterwards, via a UserOp signed by the
 * session key (the on-chain validator accepts it; the point is the hook).
 *
 *   set -a; source .env; set +a; pnpm tsx scripts/install-hook.ts
 *
 * Requires: SEPOLIA_RPC_URL, BUNDLER_URL, AGENT_SESSION_KEY,
 * SMART_ACCOUNT_ADDRESS, AGENT_POLICY_HASH.
 */
import { encodeAbiParameters, encodeFunctionData, parseAbi, toFunctionSelector } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  BundlerExecutor,
  ENTRY_POINT_V07,
  JsonRpcChainReader,
  type Address,
  type Hex,
} from '../packages/sdk/src/index.ts';

const USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238' as Address;
const ROUTER = '0x3a9d48ab9751398bbfa63ad67599bb04e4bdf98b' as Address;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const rpcUrl = required('SEPOLIA_RPC_URL');
const bundlerUrl = required('BUNDLER_URL');
const account = required('SMART_ACCOUNT_ADDRESS').toLowerCase() as Address;
const hook = (process.env.AGENT_POLICY_HOOK_ADDRESS ?? '0xEbB1c3Ae1b502409E64DAA908bd7EDe9cf267E59') as Address;
const policyHash = required('AGENT_POLICY_HASH') as Hex;
const sessionKey = required('AGENT_SESSION_KEY') as Hex;

const session = privateKeyToAccount(sessionKey);

// abi.encode(Config, address[]) — field order matches AgentPolicyHook.Config.
const installData = encodeAbiParameters(
  [
    {
      type: 'tuple',
      components: [
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bool' },
      ],
    },
    { type: 'address[]' },
  ],
  [
    [USDC, 100_000_000n, 500_000_000n, 10_000_000n, policyHash, false],
    [USDC, ROUTER],
  ],
) as Hex;

const installModuleCall = encodeFunctionData({
  abi: parseAbi(['function installModule(uint256 moduleTypeId, address module, bytes calldata initData)']),
  functionName: 'installModule',
  args: [4n, hook, installData],
});

const chain = new JsonRpcChainReader({ url: rpcUrl, chainId: 11155111 });
const executor = new BundlerExecutor({
  account,
  bundlerUrl,
  entryPoint: ENTRY_POINT_V07,
  validator: '0xaBdBCE84aFd1CCD14a03ef78F55693daeE6052DB',
  chain,
  signUserOpHash: async (hash: Hex) => (await session.signMessage({ message: { raw: hash } })) as Hex,
});
const isInitSelector = toFunctionSelector('isInitialized(address)');
const already = await chain.call(hook, `${isInitSelector}${account.slice(2).padStart(64, '0')}` as Hex).catch(() => '0x');
console.log('hook isInitialized check raw:', already.slice(0, 10));

const txHash = await executor.send({ account, to: account, data: installModuleCall, value: 0n });
console.log('install tx:', txHash);
console.log(`https://sepolia.etherscan.io/tx/${txHash}`);
