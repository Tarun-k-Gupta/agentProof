import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApiServer } from '../src/server.ts';
import { encodeErc20Transfer, type PolicyDocument } from '@agentproof/sdk';

/**
 * The dashboard is the only surface in this system with a control on it: the
 * owner's approve/decline. Everything else is read-only or advisory. So the
 * questions worth testing are narrow and blunt — can somebody who is not the
 * owner approve, publish, or watch the stream, and can anything a remote party
 * controls reach the page as markup.
 */

const ROUTER = '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad';
const USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238';
const ME = '0x00000000000000000000000000000000000000a1';

const ADMIN_TOKEN = 'test-owner-token-do-not-reuse';

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
  api = await createApiServer({ policy: POLICY, port: 0, adminToken: ADMIN_TOKEN });
  await api.listen(0);
  const address = api.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 8402}`;
});

after(async () => {
  await api.close();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

/** Logs in and returns the session cookie the server issued. */
async function login(token = ADMIN_TOKEN): Promise<string> {
  const res = await post('/v1/dashboard/login', { token });
  assert.equal(res.status, 200, 'login should succeed');
  const cookie = res.headers.get('set-cookie');
  assert.ok(cookie, 'login must issue a session cookie');
  return cookie.split(';')[0];
}

describe('dashboard session', () => {
  test('the session cookie is HttpOnly, SameSite=Strict and path-scoped', async () => {
    const res = await post('/v1/dashboard/login', { token: ADMIN_TOKEN });
    const cookie = res.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
  });

  test('the cookie does not carry the admin token', async () => {
    const cookie = await login();
    assert.ok(!cookie.includes(ADMIN_TOKEN), 'the session value must not be the token itself');
  });

  test('a wrong token is a 401 and issues no cookie', async () => {
    const res = await post('/v1/dashboard/login', { token: 'guess' });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null);
  });

  test('/health never leaks the admin token, only a fingerprint', async () => {
    const body = await (await fetch(`${base}/health`)).json();
    assert.equal(body.dashboardAuth, true);
    assert.notEqual(body.adminTokenFingerprint, ADMIN_TOKEN);
    assert.ok(!JSON.stringify(body).includes(ADMIN_TOKEN));
  });
});

describe('approval is owner-only', () => {
  test('an unauthenticated approval is refused', async () => {
    const res = await post('/v1/approve', { id: 'anything', approved: true });
    assert.equal(res.status, 401);
    assert.match((await res.json()).error, /session required/);
  });

  test('a forged session cookie is refused', async () => {
    const res = await post('/v1/approve', { id: 'anything', approved: true }, { Cookie: 'agentproof_session=forged' });
    assert.equal(res.status, 401);
  });

  test('a session gets past the guard and is then judged on the id alone', async () => {
    const cookie = await login();
    const res = await post('/v1/approve', { id: 'never-issued', approved: true }, { Cookie: cookie });
    assert.equal(res.status, 404, 'authenticated, but there is no such pending approval');
    assert.equal((await res.json()).settled, false);
  });

  test('an approval cannot be conjured for an id the server never issued', async () => {
    const cookie = await login();
    const settled = api.approver.resolve('never-issued', { approved: true, by: 'test' });
    assert.equal(settled, false);
    const res = await post('/v1/approve', { id: 'never-issued', approved: true }, { Cookie: cookie });
    assert.equal(res.status, 404);
  });
});

describe('publishing is internal-only', () => {
  test('an unauthenticated publish is refused', async () => {
    const res = await post('/v1/internal/publish', { type: 'decision', data: { decision: 'ALLOW' } });
    assert.equal(res.status, 401);
  });

  test('a dashboard session does not grant publishing', async () => {
    const cookie = await login();
    const res = await post('/v1/internal/publish', { type: 'thought', data: 'hello' }, { Cookie: cookie });
    assert.equal(res.status, 401, 'watching decisions is not permission to invent them');
  });

  test('the internal header does grant publishing', async () => {
    const res = await post(
      '/v1/internal/publish',
      { type: 'thought', data: 'hello' },
      { 'X-AgentProof-Admin': ADMIN_TOKEN },
    );
    assert.equal(res.status, 202);
  });
});

describe('the event stream is owner-only', () => {
  test('an unauthenticated subscriber is refused', async () => {
    const res = await fetch(`${base}/v1/stream`);
    assert.equal(res.status, 401);
    await res.text();
  });

  test('a session subscribes successfully', async () => {
    const cookie = await login();
    const controller = new AbortController();
    const res = await fetch(`${base}/v1/stream`, { headers: { Cookie: cookie }, signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    controller.abort();
  });
});

describe('remote data cannot become markup', () => {
  test('the dashboard builds nodes rather than assigning innerHTML', async () => {
    const html = await (await fetch(`${base}/`)).text();
    // A single innerHTML assignment fed by API data is the whole bug class; the
    // page is required to construct nodes and set textContent instead.
    assert.ok(!/\.innerHTML\s*=/.test(html), 'dashboard must not assign innerHTML');
    assert.ok(!/insertAdjacentHTML|document\.write|new Function|eval\(/.test(html));
  });

  test('a decision carrying a script payload comes back as data, not markup', async () => {
    // The summary is derived from calldata, so this is the realistic injection
    // point: an attacker chooses the recipient address and the amount.
    const res = await post('/v1/verify', {
      agent: 'trader.agentproof.eth',
      action: {
        to: USDC,
        data: encodeErc20Transfer('0x000000000000000000000000000000000000dead', 1_000_000n),
        value: '0',
        chainId: 11155111,
      },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(body.decision, 'BLOCK');
    // Everything the page renders is a string it puts in textContent; nothing
    // in the response is HTML, and the response is not served as HTML.
    assert.ok(!/[<>]/.test(JSON.stringify(body)), 'no response field may contain angle brackets');
  });

  test('a script-shaped agent name is rejected before it can be echoed', async () => {
    const res = await post('/v1/verify', {
      agent: '<script>alert(1)</script>',
      action: { to: USDC, data: '0x', value: '0', chainId: 11155111 },
    });
    assert.equal(res.status, 400);
  });
});
