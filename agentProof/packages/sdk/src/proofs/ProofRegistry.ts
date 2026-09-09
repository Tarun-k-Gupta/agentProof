import type { ProofReference } from '../core/types.ts';

/**
 * The negative control, read from proofs/summary.json.
 *
 * `PolicySpecBroken` is `PolicySpec` with an off-by-one and a missing reset
 * guard. If the checker ever verifies it cleanly, every PROVEN beside it is
 * decoration — so the counterexample it produces is surfaced next to the proofs
 * rather than buried in a log.
 */
export interface NegativeControl {
  contract: string;
  counterexampleProduced: boolean;
  counterexample?: string;
}

/**
 * Proof surfacing.
 *
 * The build pipeline emits proofs/*.json from the SMT run. The SDK loads them
 * at init and attaches the matching reference to every decision whose deciding
 * policy is formally verified, so a developer running the demo sees the proof
 * status in the same terminal block as the block reason.
 *
 * The important behaviour is the absence case. If the artifacts are missing —
 * because nobody ran the verifier, or because it returned `unknown` — the
 * status is NOT_RUN or UNPROVEN, never PROVEN. A safety product that reports a
 * proof it does not have is worse than one that reports nothing, because the
 * claim is the thing people act on.
 */
export class ProofRegistry {
  private readonly byPolicy = new Map<string, ProofReference>();
  readonly negativeControl?: NegativeControl;

  private constructor(references: readonly ProofReference[], negativeControl?: NegativeControl) {
    for (const reference of references) {
      const policy = PROPERTY_TO_POLICY[reference.property];
      if (policy) this.byPolicy.set(policy, reference);
    }
    this.negativeControl = negativeControl;
  }

  /** Loads proofs/*.json from disk. Node-only; the browser build passes them in. */
  static async load(directory: string): Promise<ProofRegistry> {
    try {
      const { readdir, readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const files = (await readdir(directory)).filter((f: string) => f.endsWith('.json') && f !== 'summary.json');

      const references: ProofReference[] = [];
      for (const file of files) {
        const parsed = JSON.parse(await readFile(join(directory, file), 'utf8')) as ProofReference;
        references.push(parsed);
      }

      let negativeControl: NegativeControl | undefined;
      try {
        const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8')) as {
          negativeControl?: NegativeControl;
        };
        negativeControl = summary.negativeControl;
      } catch {
        // No summary.json — the per-property files still stand on their own.
      }

      // An empty proofs/ directory means the verifier has not been run, which is
      // exactly what a missing directory means. Returning an empty registry
      // instead would make the API report no properties at all — quieter than
      // NOT_RUN, and less honest, because a reader would not know a proof was
      // ever expected.
      return references.length > 0 ? new ProofRegistry(references, negativeControl) : ProofRegistry.notRun();
    } catch {
      return ProofRegistry.notRun();
    }
  }

  static from(references: readonly ProofReference[], negativeControl?: NegativeControl): ProofRegistry {
    return new ProofRegistry(references, negativeControl);
  }

  /** Honest default when no artifacts exist. */
  static notRun(): ProofRegistry {
    return new ProofRegistry([
      {
        property: 'MAX_TRANSFER',
        status: 'NOT_RUN',
        tool: 'solc-smtchecker',
        solverTimeMs: 0,
        artifactPath: 'proofs/MAX_TRANSFER.json',
      },
      {
        property: 'DAILY_SPEND',
        status: 'NOT_RUN',
        tool: 'solc-smtchecker',
        solverTimeMs: 0,
        artifactPath: 'proofs/DAILY_SPEND.json',
      },
    ]);
  }

  asMap(): ReadonlyMap<string, ProofReference> {
    return this.byPolicy;
  }

  all(): ProofReference[] {
    return [...this.byPolicy.values()];
  }

  /** True only when every verified property actually verified. */
  get allProven(): boolean {
    const references = this.all();
    return references.length > 0 && references.every((r) => r.status === 'PROVEN');
  }
}

const PROPERTY_TO_POLICY: Record<ProofReference['property'], string> = {
  MAX_TRANSFER: 'maxTransaction',
  DAILY_SPEND: 'dailySpend',
};
