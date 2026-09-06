import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApiServer } from '../src/server.ts';
import { encodeErc20Transfer, encodeSwapExactIn, usdc, type PolicyDocument } from '@agentproof/sdk';

/**
 * Boots the real server on an ephemeral port and talks to it over HTTP.
 *
 * Not mocked. The point of these tests is to catch the class of failure where
 * every unit passes and the thing does not start — which is exactly what
 * happened to this package once already.
 */

const ROUTER = '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad';
const USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238';
const WETH = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14';
const ME = '0x00000000000000000000000000000000000000a1';
const ATTACKER = '0x000000000000000000000000000000000000dead';

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

let api: Awaited<ReturnType<typeof createApiServer>>;
let base: string;

before(async () => {
  api = await createApiServer({ policy: POLICY, port: 0 });
  await api.listen(0);
  const address = api.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 8402}`;
});

after(async () => {
  await api.close();
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('service surface', () => {
  test('health reports the policy hash, account and proof status', async () => {
    const body = await (await fetch(`${base}/health`)).json();
    assert.equal(body.ok, true);
    assert.match(body.policyHash, /^0x[0-9a-f]{64}$/);
    assert.equal(body.account, ME);
    assert.equal(body.agent, 'trader.agentproof.eth');
    // No artifacts in a fresh checkout, and the API must say so rather than
    // implying a proof it does not have.
    assert.deepEqual(body.proofs.map((p: { status: string }) => p.status), ['NOT_RUN', 'NOT_RUN']);
  });

  test('serves the dashboard', async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /AgentProof/);
  });

  test('unknown routes 404 rather than hanging', async () => {
    assert.equal((await fetch(`${base}/v1/nope`)).status, 404);
  });
});

describe('POST /v1/verify', () => {
  test('allows an in-limit swap', async () => {
    const body = await (
      await post('/v1/verify', {
        action: {
          value: '0',
          to: ROUTER,
          data: encodeSwapExactIn({ recipient: ME, amountIn: usdc(80), tokenIn: USDC, tokenOut: WETH }),
          chainId: 11155111,
        },
      })
    ).json();

    assert.equal(body.decision, 'ALLOW');
    assert.equal(body.intent.notionalUSDC, '80000000');
    assert.equal(body.intent.outflow[0].provenance, 'DECODED');
  });

  test('blocks an over-limit swap with the reason and the violation', async () => {
    const body = await (
      await post('/v1/verify', {
        action: {
          value: '0',
          to: ROUTER,
          data: encodeSwapExactIn({ recipient: ME, amountIn: usdc(250), tokenIn: USDC, tokenOut: WETH }),
          chainId: 11155111,
        },
      })
    ).json();

    assert.equal(body.decision, 'BLOCK');
    assert.equal(body.violations[0].policy, 'maxTransaction');
    assert.match(body.reason, /per-transaction limit/);
  });

  test('blocks a transfer to an unlisted recipient', async () => {
    const body = await (
      await post('/v1/verify', {
        action: { to: USDC, data: encodeErc20Transfer(ATTACKER, usdc(10)), value: '0', chainId: 11155111 },
      })
    ).json();
    assert.equal(body.decision, 'BLOCK');
  });

  // The response restates this on every call so the endpoint cannot be
  // mistaken for the enforcement boundary. That framing is load-bearing.
  test('every response declares itself advisory', async () => {
    const body = await (
      await post('/v1/verify', { action: { to: ROUTER, data: '0x', chainId: 11155111 } })
    ).json();
    assert.equal(body.enforcement.advisory, true);
    assert.match(body.enforcement.note, /Enforcement is the ERC-7579 hook/);
  });

  test('rejects a malformed action with 400, not 500', async () => {
    const response = await post('/v1/verify', { action: { to: 'not-an-address' } });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /must be a 20-byte address/);
  });
});

describe('POST /v1/decode', () => {
  test('returns worst-case outflow for an exact-output swap', async () => {
    const body = await (
      await post('/v1/decode', {
        to: ROUTER,
        data: encodeSwapExactIn({ recipient: ME, amountIn: usdc(42), tokenIn: USDC, tokenOut: WETH }),
        chainId: 11155111,
      })
    ).json();
    assert.equal(body.intent.kind, 'SWAP');
    assert.equal(body.intent.notionalUSDC, '42000000');
  });

  test('classifies undecodable calldata as UNKNOWN', async () => {
    const body = await (await post('/v1/decode', { to: ROUTER, data: '0xdeadbeef' })).json();
    assert.equal(body.intent.kind, 'UNKNOWN');
  });
});

describe('free read routes', () => {
  test('/v1/spend reports null on-chain spend when no RPC is configured', async () => {
    const body = await (await fetch(`${base}/v1/spend/${ME}`)).json();
    assert.equal(body.limit, '500000000');
    assert.equal(body.spentOnchain, null, 'must report absence rather than invent a number');
    assert.equal(body.reconciled, null);
  });

  test('/v1/proofs is honest about not having run', async () => {
    const body = await (await fetch(`${base}/v1/proofs`)).json();
    assert.equal(body.allProven, false);
  });

  test('/v1/policy returns the document and its hash', async () => {
    const body = await (await fetch(`${base}/v1/policy/trader.agentproof.eth`)).json();
    assert.equal(body.name, 'trader.agentproof.eth');
    assert.match(body.policyHash, /^0x[0-9a-f]{64}$/);
  });
});

describe('dashboard stream', () => {
  test('publishes decisions to connected clients', async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}/v1/stream`, { signal: controller.signal });
    assert.equal(response.headers.get('content-type'), 'text/event-stream');

    const reader = response.body!.getReader();
    await reader.read(); // the ': connected' preamble

    await post('/v1/internal/publish', { type: 'decision', data: { decision: 'BLOCK', reason: 'test' } });

    const chunk = new TextDecoder().decode((await reader.read()).value);
    assert.match(chunk, /event: decision/);
    assert.match(chunk, /"decision":"BLOCK"/);
    controller.abort();
  });

  test('approving an id that was never issued 404s', async () => {
    const response = await post('/v1/approve', { id: 'made-up', approved: true });
    assert.equal(response.status, 404);
  });

  test('an approval without an id is a 400', async () => {
    assert.equal((await post('/v1/approve', { approved: true })).status, 400);
  });
});
