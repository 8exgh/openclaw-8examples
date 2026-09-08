import assert from 'node:assert/strict';
import test from 'node:test';
import { createBroker } from './broker.mjs';

const serviceToken = 'service-secret-'.repeat(4);
const ownerKey = 'a'.repeat(64);

async function fixture(t, options = {}) {
  let time = 1_000_000;
  let available = true;
  const transports = [];
  const statuses = [];
  const server = createBroker({
    serviceToken, now: () => time, ttlMs: 10000, idleMs: 3000,
    tenantCredential: (id) => available && ['alice', 'bob'].includes(id) ? id === 'alice' ? ownerKey : 'b'.repeat(64) : undefined,
    createTransport: () => {
      const transport = { closed: false, close() { this.closed = true; }, async request(action, data) {
        if (action === 'select') {
          if (data.targetId === 'missing') throw new Error('not found');
          return { targetId: 'tab1' };
        }
        if (action === 'tabs') return { targetId: 'tab1', tabs: [{ id: 'tab1', title: 'Login', url: 'https://example.com/login' }] };
        if (action === 'frame') return { image: 'pixels', width: 800, height: 600, targetId: 'tab1' };
        return { ok: true };
      } };
      transports.push(transport);
      return transport;
    },
    onStatus: (tenant, state) => statuses.push(state), ...options,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = async (path, data, headers = {}, method = data === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json', ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const owner = { 'x-remote-tenant': 'alice', 'x-remote-tenant-key': ownerKey };
  const create = () => request('/sessions', { tenant: 'alice', targetId: 'tab1' }, owner);
  return { request, owner, create, transports, statuses, tick: (ms) => time += ms, unassign: () => available = false };
}

test('link + code unlock the existing tab once; completion detaches without logging inputs', async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  assert.equal(session.status, 200);
  assert.match(session.body.url, /^https:\/\/8examples.com\/remote-connect\/[0-9a-f-]{36}$/);
  assert.match(session.body.code, /^\d{6}$/);
  const base = '/' + session.body.id;
  assert.equal((await f.request(base + '/frame')).status, 410);
  const unlock = await f.request(base + '/unlock', { code: session.body.code });
  assert.equal(unlock.status, 200);
  assert.match(unlock.body.viewerToken, /^[0-9a-f]{64}$/);
  assert.equal((await f.request(base + '/unlock', { code: session.body.code })).status, 410);
  assert.equal((await f.request(base + '/frame')).status, 401);
  const viewer = { 'x-remote-viewer': unlock.body.viewerToken };
  const frame = await f.request(base + '/frame', undefined, viewer);
  assert.equal(frame.body.image, 'pixels');
  assert.equal(frame.headers.get('cache-control'), 'no-store, private');
  assert.equal((await f.request(base + '/input', { kind: 'text', text: 'test-password' }, viewer)).status, 200);
  assert.equal((await f.request(base + '/input', { method: 'Runtime.evaluate', expression: 'process.exit()' }, viewer)).status, 400);
  assert.equal((await f.request(base + '/complete', {}, viewer)).body.status, 'completed');
  assert.equal(f.transports[0].closed, true);
  assert.equal((await f.request(base + '/frame', undefined, viewer)).status, 410);
  const state = await f.request('/sessions' + base, undefined, f.owner);
  assert.equal(state.body.status, 'completed');
  assert.ok(!JSON.stringify(f.statuses).includes('test-password'));
  assert.ok(!JSON.stringify(f.statuses).includes(session.body.code));
});

test('authentication binds creation and status to one tenant, including after unassignment', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/sessions', { tenant: 'alice' }, { Authorization: '' })).status, 401);
  assert.equal((await f.request('/sessions', { tenant: 'bob' }, f.owner)).status, 401);
  assert.equal((await f.request('/sessions', { tenant: '../alice' }, f.owner)).status, 401);
  assert.equal((await f.request('/sessions', { tenant: 'alice', targetId: 'http://internal' }, f.owner)).status, 400);
  const s = (await f.create()).body;
  assert.equal((await f.request(`/sessions/${s.id}`, undefined, { 'x-remote-tenant': 'bob', 'x-remote-tenant-key': 'b'.repeat(64) })).status, 404);
  const viewer = { 'x-remote-viewer': (await f.request(`/${s.id}/unlock`, { code: s.code })).body.viewerToken };
  f.unassign();
  assert.equal((await f.request(`/${s.id}/frame`, undefined, viewer)).status, 410);
  assert.equal(f.transports[0].closed, true);
});

test('five incorrect codes lock even a valid code; replacement invalidates old access', async (t) => {
  const f = await fixture(t);
  const s = (await f.create()).body;
  const wrongCode = s.code === '000000' ? '000001' : '000000';
  for (let n = 0; n < 5; n++) assert.equal((await f.request(`/${s.id}/unlock`, { code: wrongCode })).status, 401);
  assert.equal((await f.request(`/${s.id}/unlock`, { code: s.code })).status, 410);
  assert.equal(f.transports[0].closed, true);
  const old = (await f.create()).body;
  const viewer = { 'x-remote-viewer': (await f.request(`/${old.id}/unlock`, { code: old.code })).body.viewerToken };
  await f.create();
  assert.equal((await f.request(`/${old.id}/frame`, undefined, viewer)).status, 410);
  assert.equal((await f.request(`/sessions/${old.id}`, undefined, f.owner)).body.status, 'replaced');
});

test('absolute TTL, viewer inactivity, owner revocation, and browser readiness fail closed', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/sessions', { tenant: 'alice', targetId: 'missing' }, f.owner)).status, 503);
  assert.equal(f.transports[0].closed, true);
  const s = (await f.create()).body;
  f.tick(10001);
  assert.equal((await f.request(`/${s.id}/unlock`, { code: s.code })).status, 410);
  const idle = (await f.create()).body;
  const viewer = { 'x-remote-viewer': (await f.request(`/${idle.id}/unlock`, { code: idle.code })).body.viewerToken };
  f.tick(3001);
  assert.equal((await f.request(`/${idle.id}/input`, { kind: 'text', text: 'x' }, viewer)).status, 410);
  const revoked = (await f.create()).body;
  assert.equal((await f.request(`/sessions/${revoked.id}`, undefined, f.owner, 'DELETE')).body.status, 'revoked');
  assert.equal((await f.request(`/${revoked.id}/unlock`, { code: revoked.code })).status, 410);
});

test('simultaneous unlock attempts redeem the code exactly once', async (t) => {
  const f = await fixture(t);
  const s = (await f.create()).body;
  const results = await Promise.all(Array.from({ length: 4 }, () => f.request(`/${s.id}/unlock`, { code: s.code })));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
});
