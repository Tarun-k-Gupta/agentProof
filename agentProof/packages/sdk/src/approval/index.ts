import type { ApprovalOutcome, ApprovalRequest } from '../core/types.ts';
import type { Approver, Logger } from '../ports/index.ts';
import { approvalScreenText } from '../privacy/index.ts';
import { displayUsdc } from '../utils/units.ts';

/**
 * Approval routing.
 *
 * Every approver renders the DECODED intent — recipient, asset, amount, in
 * words — and never raw calldata. A human asked to approve a hex blob is not
 * approving anything; they are clicking yes. The decoder exists precisely so
 * that the thing shown to a person is the thing that will happen.
 */

/** CI and scripted demos. Fails closed on any non-affirmative input. */
export class ConsoleApprover implements Approver {
  constructor(private readonly options: { autoApprove?: boolean; logger?: Logger } = {}) {}

  async request(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const screen = approvalScreenText(request.intent);
    this.options.logger?.log('info', 'approval required', { id: request.id });

    process.stdout.write(
      `\n  Approval required (over ${displayUsdc(request.threshold)})\n` +
        `${screen.split('\n').map((line) => `    ${line}`).join('\n')}\n`,
    );

    if (this.options.autoApprove) {
      process.stdout.write('    auto-approved (AGENTPROOF_AUTO_APPROVE)\n\n');
      return { approved: true, by: 'console:auto' };
    }

    const answer = await prompt('    approve? [y/N] ');
    return { approved: answer.trim().toLowerCase() === 'y', by: 'console' };
  }
}

/**
 * Pushes the request to the dashboard over SSE and resolves when a human
 * clicks. The dashboard only ever *carries* the decision — it never makes one.
 */
export class DashboardApprover implements Approver {
  private readonly pending = new Map<string, (outcome: ApprovalOutcome) => void>();

  constructor(private readonly publish: (request: ApprovalRequest) => void, private readonly timeoutMs = 120_000) {}

  async request(request: ApprovalRequest): Promise<ApprovalOutcome> {
    this.publish(request);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        // Timing out is a denial, not a pass. Silence is never consent.
        resolve({ approved: false, by: 'dashboard:timeout' });
      }, this.timeoutMs);

      this.pending.set(request.id, (outcome) => {
        clearTimeout(timer);
        this.pending.delete(request.id);
        resolve(outcome);
      });
    });
  }

  resolve(id: string, outcome: ApprovalOutcome): boolean {
    const settle = this.pending.get(id);
    if (!settle) return false;
    settle(outcome);
    return true;
  }

  get pendingIds(): string[] {
    return [...this.pending.keys()];
  }
}

export interface LedgerTransport {
  /** Displays the text on the device and returns a signature once confirmed. */
  confirm(text: string, payload: `0x${string}`): Promise<`0x${string}`>;
  address(): Promise<`0x${string}`>;
}

/**
 * Hardware confirmation before anything irreversible.
 *
 * The owner-signed operation goes out under the owner validator, which carries
 * a raised ceiling. The agent's session key cannot produce that signature at
 * all — escalation here is a different key, not a softer rule.
 */
export class LedgerApprover implements Approver {
  constructor(private readonly transport: LedgerTransport, private readonly logger?: Logger) {}

  async request(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const screen = approvalScreenText(request.intent);
    this.logger?.log('info', 'awaiting device confirmation', { id: request.id });

    try {
      const signature = await this.transport.confirm(screen, request.intent.raw.data);
      const by = await this.transport.address();
      return { approved: true, signature, by: `ledger:${by}` };
    } catch (error) {
      this.logger?.log('warn', 'device declined or disconnected', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { approved: false, by: 'ledger:declined' };
    }
  }
}

async function prompt(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
