import { readFile } from 'node:fs/promises';
import { runTrader } from './index.ts';
import type { Address, PolicyDocument } from '@agentproof/sdk';

/**
 * Runs the trader against the in-process account model.
 *
 * With OPENAI_API_KEY set, the proposals come from a real LangGraph agent at
 * temperature 0. Without it, a fixed transcript is replayed so CI stays
 * deterministic. Either way the policy decision is computed from whatever the
 * model actually proposed — never scripted against it.
 */
const policy = JSON.parse(
  await readFile(new URL('../../../agent.policy.json', import.meta.url), 'utf8'),
) as PolicyDocument;

const { results } = await runTrader({
  policy,
  router: policy.policies.allowedContracts[0] as Address,
});

const blocked = results.filter((r) => r.decision === 'BLOCK').length;
console.log(`\n${results.length} proposals, ${blocked} blocked by policy.`);
