import type { Action, Address, NormalizedIntent } from '../core/types.ts';
import { normalizeAddress, selectorOf } from '../utils/hex.ts';
import { UNBOUNDED } from '../utils/units.ts';

export interface DecoderContext {
  /** the protected smart account */
  account: Address;
  /** the single asset whose spend is bounded (USDC in the MVP) */
  trackedAsset: Address;
  /** decimals of the tracked asset */
  decimals: number;
}

export interface SelectorDecoder {
  readonly name: string;
  /** selectors this decoder claims; '*' means "consulted for any selector" */
  readonly selectors: readonly string[];
  decode(action: Action, ctx: DecoderContext): NormalizedIntent | undefined;
}

/**
 * Selector → decoder registry.
 *
 * An action whose selector no decoder claims is classified UNKNOWN. UNKNOWN is
 * blocked by default, and that default is not negotiable at runtime by the
 * agent — only by the operator writing `allowUnknownSelectors: true` in
 * configuration, where it is visible in review.
 *
 * Refusing to decide on calldata you cannot read is the whole discipline. A
 * decoder that guesses is worse than no decoder, because it produces a number
 * that looks authoritative.
 */
export class DecoderRegistry {
  private readonly bySelector = new Map<string, SelectorDecoder>();
  private readonly wildcards: SelectorDecoder[] = [];

  register(decoder: SelectorDecoder): this {
    for (const selector of decoder.selectors) {
      if (selector === '*') {
        this.wildcards.push(decoder);
        continue;
      }
      const existing = this.bySelector.get(selector.toLowerCase());
      if (existing && existing.name !== decoder.name) {
        throw new Error(
          `Selector ${selector} is claimed by both '${existing.name}' and '${decoder.name}'. ` +
            'Ambiguous decoding would make policy decisions depend on registration order.',
        );
      }
      this.bySelector.set(selector.toLowerCase(), decoder);
    }
    return this;
  }

  decode(action: Action, ctx: DecoderContext): NormalizedIntent {
    const selector = selectorOf(action.data);
    const decoder = this.bySelector.get(selector.toLowerCase());

    const candidates = decoder ? [decoder, ...this.wildcards] : this.wildcards;
    for (const candidate of candidates) {
      const intent = candidate.decode(action, ctx);
      if (intent) return intent;
    }

    return {
      kind: 'UNKNOWN',
      target: normalizeAddress(action.to),
      selector,
      nativeValue: action.value,
      // An unreadable call can move anything, so its worst case is unbounded.
      outflow: [{ asset: ctx.trackedAsset, amount: UNBOUNDED, provenance: 'DECLARED' }],
      notionalUSDC: UNBOUNDED,
      summary: `Unrecognised call ${selector} to ${action.to}`,
      raw: action,
    };
  }

  knownSelectors(): string[] {
    return [...this.bySelector.keys()].sort();
  }
}
