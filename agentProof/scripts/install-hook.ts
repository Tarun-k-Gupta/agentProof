/**
 * Installs AgentPolicyHook on the live account, carrying the hash of the
 * current agent.policy.json.
 *
 * The hook carries keccak256(canonical agent.policy.json), which covers the
 * account address itself — so it cannot be part of the counterfactual
 * initCode and is installed here, afterwards, via a UserOp signed by the
 * session key (the on-chain validator accepts it; the point is the hook).
 *
 * Idempotent owner-update path: if a hook is already installed it is
 * uninstalled first, then the new config goes in. Policy evolution is a
 * first-class flow, not a redeploy.
 *
 *   set -a; source .env; set +a; pnpm tsx scripts/install-hook.ts
 *
 * Requires: SEPOLIA_RPC_URL, BUNDLER_URL, AGENT_SESSION_KEY,
 * SMART_ACCOUNT_ADDRESS. Reads limits + targets from agent.policy.json.
 */
import { readFile } from 'node:fs/promises';
import { encodeAbiParameters, encodeFunctionData, parseAbi, toFunctionSelector } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  BundlerExecutor,
  ENTRY_POINT_V07,
  JsonRpcChainReader,
  policyHash,
  type Address,
  type Hex,
  type PolicyDocument,
} from '../packages/sdk/src/index.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const rpcUrl = required('SEPOLIA_RPC_URL');
const bundlerUrl = required('BUNDLER_URL');
const account = required('SMART_ACCOUNT_ADDRESS').toLowerCase() as Address;
const sessionKey = required('AGENT_SESSION_KEY') as Hex;

const policy = JSON.parse(await readFile(new URL('../agent.policy.json', import.meta.url), 'utf8')) as PolicyDocument;
const hash = policyHash(policy);
const hook = policy.enforcement.hook as Address;
if (/^0x0{40}$/i.test(hook)) throw new Error('agent.policy.json enforcement.hook is unset');
const asset = policy.asset.address as Address;
const targets = policy.policies.allowedContracts as Address[];

const maxTx = BigInt(policy.policies.maxTransaction);
const daily = BigInt(policy.policies.dailySpend);
const floor = BigInt(policy.policies.minBalance);

console.log('policy hash:', hash);

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
  [[asset, maxTx, daily, floor, hash, false], targets],
) as Hex;

const accountAbi = parseAbi([
  'function installModule(uint256 moduleTypeId, address module, bytes calldata initData)',
  'function uninstallModule(uint256 moduleTypeId, address module, bytes calldata deInitData)',
  'function isModuleInstalled(uint256 moduleTypeId, address module, bytes calldata additionalContext) returns (bool)',
]);

const chain = new JsonRpcChainReader({ url: rpcUrl, chainId: 11155111 });
const executor = new BundlerExecutor({
  account,
  bundlerUrl,
  entryPoint: ENTRY_POINT_V07,
  validator: '0xaBdBCE84aFd1CCD14a03ef78F55693daeE6052DB',
  chain,
  signUserOpHash: async (h: Hex) => (await session.signMessage({ message: { raw: h } })) as Hex,
});

const isInitSelector = toFunctionSelector('isInitialized(address)');
const alreadyRaw = await chain
  .call(hook, `${isInitSelector}${account.slice(2).padStart(64, '0')}` as Hex)
  .catch(() => '0x');
const already = alreadyRaw.slice(-64) === '1'.padStart(64, '0');

if (already) {
  console.log('hook installed — uninstalling first (owner update)');
  const uninstallCall = encodeFunctionData({
    abi: accountAbi,
    functionName: 'uninstallModule',
    args: [4n, hook, '0x'],
  });
  console.log('uninstall tx:', await executor.send({ account, to: account, data: uninstallCall, value: 0n }));
}

const installModuleCall = encodeFunctionData({
  abi: accountAbi,
  functionName: 'installModule',
  args: [4n, hook, installData],
});

const txHash = await executor.send({ account, to: account, data: installModuleCall, value: 0n });
console.log('install tx:', txHash);
console.log(`https://sepolia.etherscan.io/tx/${txHash}`);
