/**
 * Checks that every address in a deployment manifest is real.
 *
 *   SEPOLIA_RPC_URL=... pnpm tsx scripts/verify-deployment.ts
 *
 * A manifest is only useful if it is true. The failure this guards against is
 * not a typo — a typo usually produces an address with no bytecode, which is
 * easy to notice. It is the address that *does* have bytecode and is simply the
 * wrong contract: the repo listed a real, deployed, pre-v4 Universal Router as
 * the router to allowlist for months, and nothing failed, because it exists.
 *
 * So this script reports two things per address: whether there is code there,
 * and whether anything has called it recently. An allowlisted contract that
 * nothing has touched in twenty thousand blocks deserves a second look.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RPC = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const BLOCK_SPAN = Number(process.env.VERIFY_BLOCK_SPAN ?? 20_000);

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(here, '../deployments/sepolia.json');

const ZERO = '0x0000000000000000000000000000000000000000';

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = (await response.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result as T;
}

/** Every 0x-prefixed 20-byte value in the manifest, with the path that names it. */
function addresses(node: unknown, path: string[] = []): Array<{ key: string; address: string }> {
  if (typeof node === 'string') {
    return /^0x[0-9a-fA-F]{40}$/.test(node) ? [{ key: path.join('.'), address: node.toLowerCase() }] : [];
  }
  if (Array.isArray(node)) return node.flatMap((item, i) => addresses(item, [...path, String(i)]));
  if (node && typeof node === 'object') {
    return Object.entries(node)
      .filter(([key]) => !key.startsWith('_'))
      .flatMap(([key, value]) => addresses(value, [...path, key]));
  }
  return [];
}

async function main(): Promise<void> {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as Record<string, unknown>;
  const latest = Number(await rpc<string>('eth_blockNumber', []));
  const fromBlock = `0x${(latest - BLOCK_SPAN).toString(16)}`;

  const found = addresses(manifest).filter((entry) => entry.address !== ZERO);
  const undeployed = addresses(manifest).filter((entry) => entry.address === ZERO);

  let failures = 0;
  const verified: string[] = [];

  console.log(`Sepolia at block ${latest}\n`);
  for (const { key, address } of found) {
    const code = await rpc<string>('eth_getCode', [address, 'latest']);
    const bytes = code && code !== '0x' ? (code.length - 2) / 2 : 0;
    let activity = 0;
    try {
      const logs = await rpc<unknown[]>('eth_getLogs', [{ address, fromBlock, toBlock: 'latest' }]);
      activity = logs.length;
    } catch {
      activity = -1; // the node refused the range; not a finding about the address
    }

    if (bytes === 0) {
      console.log(`  FAIL  ${key.padEnd(34)} ${address}  no bytecode`);
      failures += 1;
      continue;
    }
    const note =
      activity === 0
        ? `  ${bytes} bytes, but no logs in ${BLOCK_SPAN} blocks — confirm this is the contract you meant`
        : activity < 0
          ? `  ${bytes} bytes`
          : `  ${bytes} bytes, ${activity} logs in ${BLOCK_SPAN} blocks`;
    console.log(`  ok    ${key.padEnd(34)} ${address}${note}`);
    verified.push(key);
  }

  for (const { key } of undeployed) {
    console.log(`  --    ${key.padEnd(34)} not deployed yet`);
  }

  if (process.env.WRITE_MANIFEST === 'true' && failures === 0) {
    manifest.verified = {
      checkedAtBlock: latest,
      checkedOn: new Date().toISOString().slice(0, 10),
      method: 'eth_getCode against a Sepolia node; see scripts/verify-deployment.ts',
      addresses: verified,
    };
    await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`\nupdated ${MANIFEST}`);
  }

  if (failures > 0) {
    console.error(`\n${failures} address(es) in the manifest have no bytecode.`);
    process.exit(1);
  }
  console.log(`\n${verified.length} verified, ${undeployed.length} still to deploy.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
