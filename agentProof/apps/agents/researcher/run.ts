import { readFile } from 'node:fs/promises';
import { runResearcher, stubSigner } from './index.ts';
import type { Address, PolicyDocument } from '@agentproof/sdk';

/**
 * Pays for verification queries over x402.
 *
 * Without Hedera credentials the stub signer produces a well-formed payload the
 * facilitator will reject. That is deliberate: a demo that fakes a settlement
 * proves nothing about settlement.
 */
const policy = JSON.parse(
  await readFile(new URL('../../../agent.policy.json', import.meta.url), 'utf8'),
) as PolicyDocument;

await runResearcher({
  policy,
  serviceUrl: process.env.X402_SERVICE_URL ?? 'http://localhost:8402',
  signer: stubSigner(process.env.HEDERA_ACCOUNT_ID),
  facilitator: (process.env.X402_FACILITATOR_ADDRESS ??
    '0x00000000000000000000000000000000000000f4') as Address,
  queries: ['is this swap within policy?', 'decode this router calldata'],
});
