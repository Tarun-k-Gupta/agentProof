import type { Approver, Logger } from '../ports/index.ts';
import { LedgerApprover, type LedgerTransport } from './index.ts';

/**
 * Ledger wiring, behind LEDGER_APPROVAL_ENABLED.
 *
 * The flag was declared in .env.example from the start and read by nothing,
 * which is the worst of both worlds: an operator sets it, sees no error, and
 * believes actions are being confirmed on hardware when they are being
 * confirmed by whoever has the dashboard open.
 *
 * So the rule here is that turning the flag on and failing to reach a device is
 * a startup failure, not a fallback. Silently downgrading hardware
 * confirmation to a browser click is a change to the trust model, and it is not
 * one an error handler gets to make on the operator's behalf.
 */

export class LedgerUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `LEDGER_APPROVAL_ENABLED=true but no Ledger could be reached: ${reason}. ` +
        'Refusing to start. Unset the flag to approve from the dashboard instead — ' +
        'that is a real downgrade, so it has to be a decision rather than a fallback.',
    );
    this.name = 'LedgerUnavailableError';
  }
}

export interface LedgerOptions {
  /** BIP-44 path of the owner key on the device. */
  derivationPath?: string;
  logger?: Logger;
}

/**
 * Opens a transport to a connected device.
 *
 * `@ledgerhq/*` are optional dependencies and imported dynamically, so the SDK
 * installs and the test suite runs on machines that have never seen a Ledger.
 */
export async function createLedgerTransport(options: LedgerOptions = {}): Promise<LedgerTransport> {
  const path = options.derivationPath ?? "44'/60'/0'/0/0";

  let TransportNodeHid: { create(): Promise<unknown> };
  let Eth: new (transport: unknown) => {
    getAddress(path: string): Promise<{ address: string }>;
    signPersonalMessage(path: string, hex: string): Promise<{ v: number; r: string; s: string }>;
  };

  try {
    // Specifier held in a variable so TypeScript does not try to resolve types
    // for an optional dependency that is absent on almost every machine this
    // builds on. The shapes are pinned by the local declarations above instead.
    const transportModule = '@ledgerhq/hw-transport-node-hid';
    const ethModule = '@ledgerhq/hw-app-eth';
    ({ default: TransportNodeHid } = (await import(transportModule)) as { default: typeof TransportNodeHid });
    ({ default: Eth } = (await import(ethModule)) as { default: typeof Eth });
  } catch (error) {
    throw new LedgerUnavailableError(
      `the Ledger libraries are not installed (${error instanceof Error ? error.message : String(error)}). ` +
        'Install @ledgerhq/hw-transport-node-hid and @ledgerhq/hw-app-eth',
    );
  }

  let eth: InstanceType<typeof Eth>;
  try {
    eth = new Eth(await TransportNodeHid.create());
    // Fail here rather than at the first approval. A device that is plugged in
    // but locked, or on the wrong app, should stop the agent before it has
    // proposed anything.
    await eth.getAddress(path);
  } catch (error) {
    throw new LedgerUnavailableError(
      error instanceof Error ? error.message : 'the device did not respond — unlocked, with the Ethereum app open?',
    );
  }

  return {
    async address() {
      const { address } = await eth.getAddress(path);
      return address.toLowerCase() as `0x${string}`;
    },

    /**
     * The device shows `text` — a decoded, human-readable intent — and signs it.
     *
     * Deliberately signs the rendered text rather than the raw calldata. A
     * hardware wallet that asks its owner to approve an opaque byte string is a
     * confirmation dialog, not consent: the owner cannot tell a 100 USDC swap
     * from a 100,000 USDC one. What is signed is what was shown.
     */
    async confirm(text: string) {
      const hex = Buffer.from(text, 'utf8').toString('hex');
      const { v, r, s } = await eth.signPersonalMessage(path, hex);
      const vHex = v.toString(16).padStart(2, '0');
      return `0x${r}${s}${vHex}` as `0x${string}`;
    },
  };
}

/**
 * Chooses the approver for this process.
 *
 * @param fallback used when the flag is off — normally DashboardApprover, and
 *                 ConsoleApprover in CI.
 */
export async function selectApprover(options: {
  env?: Record<string, string | undefined>;
  fallback: Approver;
  ledger?: LedgerOptions;
  logger?: Logger;
}): Promise<Approver> {
  const env = options.env ?? (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

  if (env.LEDGER_APPROVAL_ENABLED !== 'true') {
    options.logger?.log('info', 'approvals route to the fallback approver', {
      reason: 'LEDGER_APPROVAL_ENABLED is not true',
    });
    return options.fallback;
  }

  const transport = await createLedgerTransport({ ...options.ledger, logger: options.logger });
  options.logger?.log('info', 'approvals route to a Ledger device', { address: await transport.address() });
  return new LedgerApprover(transport, options.logger);
}
