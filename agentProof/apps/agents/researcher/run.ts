import { readFile } from 'node:fs/promises';
import { runResearcher, stubSigner } from './index.ts';
import { hederaSigner } from '@agentproof/x402-client';
import type { Address, PolicyDocument } from '@agentproof/sdk';

/**
 * Pays for verification queries over x402.
 *
 * With HEDERA_PRIVATE_KEY set, the researcher signs real exact-scheme
 * transfers the facilitator settles. Without it the stub signer produces a
 * well-formed payload the facilitator will reject. That is deliberate: a
 * demo that fakes a settlement proves nothing about settlement.
 */
const policy = JSON.parse(
  await readFile(new URL('../../../agent.policy.json', import.meta.url), 'utf8'),
) as PolicyDocument;

await runResearcher({
  policy,
  serviceUrl: process.env.X402_SERVICE_URL ?? 'http://localhost:8402',
  signer:
    process.env.HEDERA_PRIVATE_KEY && process.env.HEDERA_ACCOUNT_ID
      ? hederaSigner({
          accountId: process.env.HEDERA_ACCOUNT_ID,
          privateKey: process.env.HEDERA_PRIVATE_KEY,
          network: process.env.HEDERA_NETWORK === 'mainnet' ? 'mainnet' : 'testnet',
        })
      : stubSigner(process.env.HEDERA_ACCOUNT_ID),
  // Real facilitator as EVM-mapped address (0.0.7162784 from /supported);
  // override with X402_FACILITATOR_ADDRESS to point at a self-hosted one.
  facilitator: (process.env.X402_FACILITATOR_ADDRESS ?? '0x00000000000000000000000000000000006d4b60') as Address,
  queries: ['is this swap within policy?', 'decode this router calldata'],
});
