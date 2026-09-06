import type { LogLevel, Logger } from '../ports/index.ts';
import { redact } from '../privacy/index.ts';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Structured logger that redacts on the way in, not on the way out.
 *
 * Redaction happens here rather than at the sink so that there is no
 * configuration in which the unredacted value reaches a log line. A logger you
 * can accidentally configure into leaking keys is not a safety control.
 */
export class ConsoleLogger implements Logger {
  constructor(private readonly minimum: LogLevel = 'info') {}

  log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
    if (ORDER[level] < ORDER[this.minimum]) return;
    const safe = redact(fields) as Record<string, unknown>;
    const suffix = Object.keys(safe).length > 0 ? ` ${JSON.stringify(safe)}` : '';
    const line = `[agentproof] ${level.padEnd(5)} ${message}${suffix}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}

export const silentLogger: Logger = { log: () => {} };
