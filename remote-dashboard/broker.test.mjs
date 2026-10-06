import test from 'node:test';
import assert from 'node:assert/strict';
import { createBroker } from '../remote-connect/broker.mjs';

test('dashboard handoffs are tenant-bound, one-use, expiring, and never reconnect into a new browser', async t => {
  const service = 's'.repeat(64), key = 'a'.repeat(64);
  let now = 100000, enabled = true;
  const transports = [];
  const server = createBroker({ serviceToken: service, publicPath: 'remote-dashboard', recreateTransport: false,
    now: () => now, ttlMs: 10000, idleMs: 3000,
    tenantCredential: tenant => enabled && tenant === 'alice' ? key : undefined,
    createTransport() {
      const transport = { closed: false, close() { this.closed = true; }, async request() { return { targetId: 'private-dashboard' }; } };
      transports.push(transport); return transport;
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.shutdown());
  const call = async (path, body, headers = {}, method = body ? 'POST' : 'GET') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { Authorization: `Bearer ${service}`, 'Content-Type': 'application/json', ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const owner = { 'x-remote-tenant': 'alice', 'x-remote-tenant-key': key };
  const create = async () => (await call('/sessions', { tenant: 'alice' }, owner)).body;
  assert.equal((await call('/sessions', { tenant: 'alice' })).status, 401);
  assert.equal((await call('/sessions', { tenant: 'bob' }, owner)).status, 401);
  for (const data of [{ targetId: 'ordinary-login-tab' }, { url: 'http://internal/' }]) {
    assert.equal((await call('/sessions', { tenant: 'alice', ...data }, owner)).status, 400);
  }
  const s = await create();
  assert.match(s.url, /^https:\/\/8examples.com\/remote-dashboard\/[0-9a-f-]{36}$/);
  const results = await Promise.all([1, 2, 3].map(() => call(`/${s.id}/unlock`, { code: s.code })));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  const viewer = { 'x-remote-viewer': results.find(r => r.status === 200).body.viewerToken };
  assert.equal((await call(`/${s.id}/state`)).status, 401);
  assert.equal((await call(`/${s.id}/state`, undefined, viewer)).status, 200);
  transports[0].close();
  assert.equal((await call(`/${s.id}/state`, undefined, viewer)).status, 410);
  assert.equal(transports.length, 1, 'must not create a fresh authenticated dashboard after a disconnect');
  const expired = await create(); now += 10001;
  assert.equal((await call(`/${expired.id}/unlock`, { code: expired.code })).status, 410);
  assert(transports.at(-1).closed);
  const locked = await create();
  for (let i = 0; i < 5; i++) assert.equal((await call(`/${locked.id}/unlock`, { code: locked.code === '000000' ? '000001' : '000000' })).status, 401);
  assert.equal((await call(`/${locked.id}/unlock`, { code: locked.code })).status, 410);
  const revoked = await create(); enabled = false;
  assert.equal((await call(`/${revoked.id}/unlock`, { code: revoked.code })).status, 410);
  assert(transports.at(-1).closed);
});
