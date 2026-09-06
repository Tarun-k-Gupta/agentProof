import { readFile } from 'node:fs/promises';
import { createApiServerFromEnv } from './server.ts';
import type { PolicyDocument } from '@agentproof/sdk';

const policyPath = process.env.AGENTPROOF_POLICY ?? new URL('../../../agent.policy.json', import.meta.url).pathname;
const policy = JSON.parse(await readFile(policyPath, 'utf8')) as PolicyDocument;

const api = await createApiServerFromEnv(policy);

await api.listen();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void api.close().then(() => process.exit(0));
  });
}
