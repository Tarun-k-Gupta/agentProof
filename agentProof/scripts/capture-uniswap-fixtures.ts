/**
 * Captures real Universal Router calldata from Sepolia into the decoder's
 * fixture file.
 *
 *   SEPOLIA_RPC_URL=... pnpm tsx scripts/capture-uniswap-fixtures.ts
 *
 * Why this exists: the decoder's unit tests used to be written entirely against
 * calldata produced by our own encoder, which meant they proved the encoder and
 * the decoder agreed with each other and nothing about whether either agreed
 * with Uniswap. Running this and re-reading the expectations is how that stays
 * honest.
 *
 * The search starts from the v4 PoolManager's logs rather than from a router
 * address, because it is the pool — not the router — that every real swap has
 * to touch. Routers come and go; several of the transactions this finds are
 * third-party routers with their own command extensions, which is exactly the
 * traffic a policy engine has to survive.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const RPC = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const POOL_MANAGER = process.env.V4_POOL_MANAGER ?? '0xe03a1074c86cfedd5c142c4f04f1a1536e203543';
const BLOCK_SPAN = Number(process.env.CAPTURE_BLOCK_SPAN ?? 20_000);
const EXECUTE_SELECTORS = new Set(['0x3593564c', '0x24856bc3']);

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '../packages/sdk/tests/fixtures/uniswap-sepolia.json');

interface CapturedTransaction {
  commands: string;
  transactionHash: string;
  blockNumber: number;
  router: string;
  from: string;
  value: string;
  data: string;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const json = (await response.json()) as { result?: T; error?: { message: string } };
      if (json.error) throw new Error(json.error.message);
      return json.result as T;
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw new Error('unreachable');
}

/** The `commands` byte string of an execute() call — our fixture's identity. */
function commandsOf(data: string): string {
  const body = data.slice(10);
  const word = (index: number) => Number(BigInt(`0x${body.slice(index * 64, index * 64 + 64)}`));
  const offset = word(0) * 2;
  const length = Number(BigInt(`0x${body.slice(offset, offset + 64)}`));
  return `0x${body.slice(offset + 64, offset + 64 + length * 2)}`;
}

async function main(): Promise<void> {
  const latest = Number(await rpc<string>('eth_blockNumber', []));
  const fromBlock = `0x${(latest - BLOCK_SPAN).toString(16)}`;
  console.log(`scanning ${POOL_MANAGER} logs from block ${latest - BLOCK_SPAN} to ${latest}`);

  const logs = await rpc<Array<{ transactionHash: string }>>('eth_getLogs', [
    { address: POOL_MANAGER, fromBlock, toBlock: 'latest' },
  ]);
  const hashes = [...new Set(logs.map((log) => log.transactionHash))];
  console.log(`${logs.length} logs across ${hashes.length} transactions`);

  // One fixture per distinct command stream. Ten copies of the same swap prove
  // nothing the first one did not.
  const byCommands = new Map<string, CapturedTransaction>();
  for (const hash of hashes) {
    const tx = await rpc<{
      to: string | null;
      from: string;
      value: string;
      input: string;
      blockNumber: string;
    } | null>('eth_getTransactionByHash', [hash]);
    if (!tx?.to || !EXECUTE_SELECTORS.has(tx.input.slice(0, 10))) continue;

    let commands: string;
    try {
      commands = commandsOf(tx.input);
    } catch {
      continue;
    }
    if (byCommands.has(commands)) continue;

    byCommands.set(commands, {
      commands,
      transactionHash: hash,
      blockNumber: Number(BigInt(tx.blockNumber)),
      router: tx.to.toLowerCase(),
      from: tx.from.toLowerCase(),
      value: tx.value,
      data: tx.input,
    });
  }

  const transactions = [...byCommands.values()].sort((a, b) => a.blockNumber - b.blockNumber);
  console.log(`captured ${transactions.length} distinct command streams:`);
  for (const tx of transactions) console.log(`  ${tx.commands.padEnd(18)} ${tx.transactionHash}`);

  await writeFile(
    OUT,
    `${JSON.stringify(
      {
        _comment:
          'Real Universal Router calldata captured from Sepolia. Regenerate with ' +
          'scripts/capture-uniswap-fixtures.ts. Every entry names the transaction it came from, ' +
          'so any expectation here can be checked against a block explorer.',
        network: 'sepolia',
        chainId: 11155111,
        capturedAt: new Date().toISOString().slice(0, 10),
        transactions,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nwrote ${OUT}`);
  console.log('Re-read tests/unit/uniswap-live.test.ts before committing: new command streams');
  console.log('will not have expectations, and a changed bound is a finding, not a chore.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
