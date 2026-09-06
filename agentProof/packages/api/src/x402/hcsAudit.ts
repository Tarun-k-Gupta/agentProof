import type { Logger, PublicAuditRecord } from '@agentproof/sdk';

/**
 * Hedera Consensus Service audit trail.
 *
 * What goes on the topic is deliberately not the decision record. It is the
 * privacy projection of it: policy hash, decision, which policy decided, an
 * order-of-magnitude bucket, and a commitment binding the entry to the full
 * intent. An HCS topic is permanent and world-readable, and writing exact
 * amounts and counterparties to one would publish an agent's entire cash-flow
 * history to anybody who cares to read it.
 *
 * The commitment is what keeps the trail useful: an operator can later reveal
 * the preimage for any single entry and prove it was not written after the
 * fact, without disclosing every other entry to do so.
 */
export interface HcsSubmitter {
  submitMessage(topicId: string, message: string): Promise<{ transactionId: string; sequenceNumber: number }>;
}

export class HcsAuditTrail {
  private readonly queue: PublicAuditRecord[] = [];
  private flushing = false;

  constructor(
    private readonly options: { topicId: string; submitter: HcsSubmitter; logger?: Logger; enabled: boolean },
  ) {}

  /** Non-blocking. An audit write must never delay or fail a policy decision. */
  record(record: PublicAuditRecord): void {
    if (!this.options.enabled) return;
    this.queue.push(record);
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const record = this.queue.shift()!;
        try {
          const receipt = await this.options.submitter.submitMessage(
            this.options.topicId,
            JSON.stringify(record),
          );
          this.options.logger?.log('debug', 'audit record published', {
            sequenceNumber: receipt.sequenceNumber,
            decision: record.decision,
          });
        } catch (error) {
          this.options.logger?.log('warn', 'audit write failed, dropping record', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}

/**
 * Real submitter, built on @hashgraph/sdk. Imported dynamically so the API can
 * boot — and the test suite can run — without Hedera credentials present.
 */
export async function createHederaSubmitter(config: {
  accountId: string;
  privateKey: string;
  network: 'testnet' | 'mainnet';
}): Promise<HcsSubmitter> {
  const { Client, PrivateKey, TopicMessageSubmitTransaction } = await import('@hashgraph/sdk');

  const client = config.network === 'testnet' ? Client.forTestnet() : Client.forMainnet();
  client.setOperator(config.accountId, PrivateKey.fromStringECDSA(config.privateKey));

  return {
    async submitMessage(topicId: string, message: string) {
      const response = await new TopicMessageSubmitTransaction({ topicId, message }).execute(client);
      const receipt = await response.getReceipt(client);
      return {
        transactionId: response.transactionId.toString(),
        sequenceNumber: Number(receipt.topicSequenceNumber ?? 0),
      };
    },
  };
}
