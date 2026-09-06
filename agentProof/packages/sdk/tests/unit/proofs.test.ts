import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProofRegistry } from '../../src/proofs/ProofRegistry.ts';

/**
 * proofs/*.json is a generated artifact and is not committed, so every
 * consumer of this registry has to survive the artifacts being absent. The
 * failure mode that matters is not a crash — it is a registry that quietly
 * reports nothing, letting a caller conclude there was never a proof to run.
 */
describe('ProofRegistry without artifacts', () => {
  test('a missing directory reports NOT_RUN for every expected property', async () => {
    const registry = await ProofRegistry.load(join(tmpdir(), 'agentproof-does-not-exist-9d2f'));

    assert.deepEqual(registry.all().map((p) => p.property).sort(), ['DAILY_SPEND', 'MAX_TRANSFER']);
    assert.ok(registry.all().every((p) => p.status === 'NOT_RUN'));
    assert.equal(registry.allProven, false);
  });

  test('an empty directory is treated the same as a missing one', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentproof-proofs-'));
    const registry = await ProofRegistry.load(directory);

    assert.ok(registry.all().every((p) => p.status === 'NOT_RUN'));
    assert.equal(registry.allProven, false);
  });

  test('allProven is false unless every property actually proved', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentproof-proofs-'));
    await writeFile(
      join(directory, 'MAX_TRANSFER.json'),
      JSON.stringify({ property: 'MAX_TRANSFER', status: 'PROVEN', tool: 'solc-smtchecker', solverTimeMs: 1 }),
    );
    await writeFile(
      join(directory, 'DAILY_SPEND.json'),
      JSON.stringify({ property: 'DAILY_SPEND', status: 'UNPROVEN', tool: 'solc-smtchecker', solverTimeMs: 1 }),
    );

    const registry = await ProofRegistry.load(directory);
    assert.equal(registry.allProven, false, 'one unproved property makes the set unproved');
  });

  test('a fully proven set reports allProven', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentproof-proofs-'));
    for (const property of ['MAX_TRANSFER', 'DAILY_SPEND']) {
      await writeFile(
        join(directory, `${property}.json`),
        JSON.stringify({ property, status: 'PROVEN', tool: 'solc-smtchecker', solverTimeMs: 1 }),
      );
    }

    assert.equal((await ProofRegistry.load(directory)).allProven, true);
  });
});
