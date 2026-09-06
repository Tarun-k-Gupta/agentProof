import { readFile } from 'node:fs/promises';
import { createApiServer } from './server.ts';
import type { PolicyDocument } from '@agentproof/sdk';

const policyPath = process.env.AGENTPROOF_POLICY ?? new URL('../../../agent.policy.json', import.meta.url).pathname;
const policy = JSON.parse(await readFile(policyPath, 'utf8')) as PolicyDocument;

const x402Enabled = process.env.X402_ENABLED === 'true';

const api = await createApiServer({
  policy,
  port: Number(process.env.PORT ?? 8402),
  x402: {
    enabled: x402Enabled,
    facilitatorUrl: process.env.X402_FACILITATOR_URL ?? 'https://facilitator.blocky402.io',
    network: process.env.HEDERA_NETWORK === 'mainnet' ? 'hedera-mainnet' : 'hedera-testnet',
    asset: process.env.HEDERA_USDC_TOKEN_ID ?? '0.0.429274',
    payTo: process.env.HEDERA_ACCOUNT_ID ?? '0.0.0',
    priceVerify: process.env.X402_PRICE_VERIFY_USDC ?? '0.01',
    priceDecode: process.env.X402_PRICE_DECODE_USDC ?? '0.005',
    baseUrl: process.env.API_PUBLIC_URL ?? 'http://localhost:8402',
  },
  hedera:
    process.env.HCS_AUDIT_TOPIC_ID && process.env.HEDERA_PRIVATE_KEY
      ? {
          accountId: process.env.HEDERA_ACCOUNT_ID!,
          privateKey: process.env.HEDERA_PRIVATE_KEY!,
          topicId: process.env.HCS_AUDIT_TOPIC_ID,
          network: process.env.HEDERA_NETWORK === 'mainnet' ? 'mainnet' : 'testnet',
        }
      : undefined,
});

await api.listen();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void api.close().then(() => process.exit(0));
  });
}
