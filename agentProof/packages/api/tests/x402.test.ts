import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApiServer } from '../src/server.ts';
import type { Facilitator, PaymentRequirements, SettlementResult } from '../src/x402/blocky402.ts';
import type { HcsSubmitter } from '../src/x402/hcsAudit.ts';
import { encodeSwapExactIn, type PolicyDocument } from '@agentproof/sdk';

/**
 * The paid path, end to end over HTTP, with a fake facilitator and a fake HCS
 * submitter.
 *
 * These are the properties that cost money or leak money if they regress:
 * payment is verified before the work, settled only after it, a payload buys
 * exactly one call, and a facilitator outage is our 503 rather than the
 * caller's silent charge.
 */

const ROUTER = '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad';
const USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238';
const WETH = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14';
const ME = '0x00000000000000000000000000000000000000a1';

const POLICY: PolicyDocument = {
  version: 'agentproof/v1',
  agent: 'trader.agentproof.eth',
  chainId: 11155111,
  asset: { address: USDC, decimals: 6 },
  policies: {
    maxTransaction: '100000000',
    dailySpend: '500000000',
    approvalThreshold: '100000000',
    minBalance: '10000000',
    allowedContracts: [ROUTER],
    allowedRecipients: [ME],
  },
  enforcement: { hook: '0x0000000000000000000000000000000000000000', account: ME },
};

class FakeFacilitator implements Facilitator {
  valid = true;
  settles = true;
  throwOnVerify = false;
  throwOnSettle = false;
  readonly verified: string[] = [];
  readonly settled: string[] = [];

  async verify(payload: string): Promise<{ valid: boolean; reason?: string }> {
    if (this.throwOnVerify) throw new Error('facilitator timed out');
    this.verified.push(payload);
    return this.valid ? { valid: true } : { valid: false, reason: 'insufficient funds' };
  }

  async settle(payload: string, _requirements: PaymentRequirements): Promise<SettlementResult> {
    if (this.throwOnSettle) throw new Error('settle timed out');
    this.settled.push(payload);
    return this.settles
      ? { settled: true, transactionId: '0.0.1234@1700000000.000000000', network: 'hedera:testnet' }
      : { settled: false, reason: 'payer account has no USDC association' };
  }
}

class FakeHcs implements HcsSubmitter {
  readonly messages: string[] = [];
  async submitMessage(_topicId: string, message: string) {
    this.messages.push(message);
    return { transactionId: 'tx', sequenceNumber: this.messages.length };
  }
}

const facilitator = new FakeFacilitator();
const hcs = new FakeHcs();

let api: Awaited<ReturnType<typeof createApiServer>>;
let base: string;

before(async () => {
  api = await createApiServer({
    policy: POLICY,
    port: 0,
    facilitator,
    hcsSubmitter: hcs,
    x402: {
      enabled: true,
      facilitatorUrl: 'http://facilitator.invalid',
      network: 'hedera:testnet',
      asset: '0.0.429274',
      assetDecimals: 6,
      payTo: '0.0.1001',
      priceVerify: '0.01',
      priceDecode: '0.005',
      baseUrl: 'http://localhost:8402',
    },
  });
  await api.listen(0);
  const address = api.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 8402}`;
});

after(async () => {
  await api.close();
});

beforeEach(() => {
  facilitator.valid = true;
  facilitator.settles = true;
  facilitator.throwOnVerify = false;
  facilitator.throwOnSettle = false;
});

/** A distinct payload per call, so tests do not replay each other's payments. */
let counter = 0;
function payment(): string {
  counter += 1;
  return Buffer.from(JSON.stringify({ scheme: 'exact', nonce: `nonce-${counter}` })).toString('base64');
}

const ACTION = {
  agent: 'trader.agentproof.eth',
  action: {
    to: ROUTER,
    data: encodeSwapExactIn({ tokenIn: USDC, tokenOut: WETH, amountIn: 50_000_000n, recipient: ME }),
    value: '0',
    chainId: 11155111,
  },
};

const post = (path: string, body: unknown, header?: string) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(header ? { 'X-PAYMENT': header } : {}) },
    body: JSON.stringify(body),
  });

function paymentResponse(res: Response): { success: boolean; transaction?: string; error?: string } {
  const raw = res.headers.get('X-PAYMENT-RESPONSE');
  assert.ok(raw, 'expected an X-PAYMENT-RESPONSE header');
  return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
}

describe('x402 gating', () => {
  test('an unpaid request gets a 402 challenge carrying the price', async () => {
    const res = await post('/v1/verify', ACTION);
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.x402Version, 1);
    assert.equal(body.accepts[0].amount, '10000'); // 0.01 USDC in atomic units: the facilitator settles exactly this
    assert.equal(body.accepts[0].network, 'hedera:testnet');
    assert.equal(body.accepts[0].resource, 'http://localhost:8402/v1/verify');
  });

  test('/v1/decode is priced separately from /v1/verify', async () => {
    const res = await post('/v1/decode', ACTION.action);
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.accepts[0].amount, '5000'); // 0.005 USDC, atomic
    assert.equal(body.accepts[0].resource, 'http://localhost:8402/v1/decode');
  });

  test('a malformed payment header is rejected without calling the facilitator', async () => {
    const before = facilitator.verified.length;
    const res = await post('/v1/verify', ACTION, 'not-base64-json!!');
    assert.equal(res.status, 402);
    assert.match((await res.json()).error, /base64-encoded JSON/);
    assert.equal(facilitator.verified.length, before);
  });

  test('a paid request is verified before the work and settled after it', async () => {
    const header = payment();
    const res = await post('/v1/verify', ACTION, header);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).decision, 'ALLOW');

    assert.ok(facilitator.verified.includes(header));
    assert.ok(facilitator.settled.includes(header));
    assert.equal(paymentResponse(res).success, true);
  });

  test('a rejected payment costs us no work', async () => {
    facilitator.valid = false;
    const res = await post('/v1/verify', ACTION, payment());
    assert.equal(res.status, 402);
    assert.match((await res.json()).error, /insufficient funds/);
  });

  test('replaying a payment payload is refused', async () => {
    const header = payment();
    assert.equal((await post('/v1/verify', ACTION, header)).status, 200);

    const replayed = await post('/v1/verify', ACTION, header);
    assert.equal(replayed.status, 402);
    assert.match((await replayed.json()).error, /already been used/);
  });

  test('a payload paid at /v1/decode cannot be replayed at /v1/verify', async () => {
    const header = payment();
    assert.equal((await post('/v1/decode', ACTION.action, header)).status, 200);
    assert.equal((await post('/v1/verify', ACTION, header)).status, 402);
  });

  test('a rejected payment can be retried, because the claim is released', async () => {
    const header = payment();
    facilitator.valid = false;
    assert.equal((await post('/v1/verify', ACTION, header)).status, 402);

    facilitator.valid = true;
    assert.equal((await post('/v1/verify', ACTION, header)).status, 200);
  });

  test('a facilitator outage is a retryable 503, not a charge', async () => {
    facilitator.throwOnVerify = true;
    const header = payment();
    const res = await post('/v1/verify', ACTION, header);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).retryable, true);
    assert.ok(!facilitator.settled.includes(header));
  });

  test('settlement failure still returns the answer, and says it was not paid', async () => {
    facilitator.settles = false;
    const res = await post('/v1/verify', ACTION, payment());
    assert.equal(res.status, 200);
    const receipt = paymentResponse(res);
    assert.equal(receipt.success, false);
    assert.match(receipt.error!, /no USDC association/);
  });

  test('a settle call that throws is reported, not propagated as a 500', async () => {
    facilitator.throwOnSettle = true;
    const res = await post('/v1/verify', ACTION, payment());
    assert.equal(res.status, 200);
    assert.equal(paymentResponse(res).success, false);
  });

  test('a rejected request is not charged and not replay-burned', async () => {
    const header = payment();
    const bad = await post('/v1/verify', { agent: 'trader.agentproof.eth', action: { to: 'nope' } }, header);
    assert.equal(bad.status, 400);
    assert.ok(!facilitator.settled.includes(header));

    // The payment was never consumed, so the caller can spend it on a valid call.
    assert.equal((await post('/v1/verify', ACTION, header)).status, 200);
  });
});

describe('HCS audit trail', () => {
  test('a settled verification writes a privacy-projected record', async () => {
    const before = hcs.messages.length;
    await post('/v1/verify', ACTION, payment());
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.ok(hcs.messages.length > before, 'expected an audit record');
    const record = JSON.parse(hcs.messages.at(-1)!);

    assert.equal(record.decision, 'ALLOW');
    assert.equal(record.policyHash, api.policyHash);
    assert.ok(Number.isInteger(record.dayUtc), 'dayUtc must survive the projection as an integer');
    assert.ok(record.dayUtc > 19_000, 'dayUtc must be a real UTC day, not NaN');
    assert.ok(/^0x[0-9a-f]{64}$/.test(record.commitment), 'commitment must bind the entry to the intent');

    // The projection is the point: no counterparty, no exact amount, no calldata.
    const serialised = JSON.stringify(record);
    assert.ok(!serialised.includes(ROUTER), 'the counterparty must not reach a public topic');
    assert.ok(!serialised.includes('50000000'), 'the exact amount must not reach a public topic');
  });
});
