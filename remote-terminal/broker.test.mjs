import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalBroker } from './broker.mjs';

async function fixture(t, options = {}) {
  let time = 100000, key = 'a'.repeat(64);
  const transports = [];
  const broker = createTerminalBroker({ serviceToken: 's'.repeat(32), now: () => time,
    tenantCredential: tenant => tenant === 'openclaw1' ? key : undefined,
    createTransport() {
      const terminal = { ready: Promise.resolve(), calls: [], closed: false,
        async request(action, data) { this.calls.push({ action, data }); },
        read(after) { return { chunks: [], cursor: after || 0, running: !this.closed, more: false, truncated: false, exitCode: null }; },
        close() { this.closed = true; } };
      transports.push(terminal); return terminal;
    }, ...options });
  await new Promise(resolve => broker.listen(0, '127.0.0.1', resolve));
  t.after(() => { broker.shutdown(); broker.closeAllConnections(); });
  const origin = `http://127.0.0.1:${broker.address().port}`;
  async function request(path, data, extra = {}, method) {
    const response = await fetch(origin + path, { method: method || (data === undefined ? 'GET' : 'POST'),
      headers: { Authorization: `Bearer ${'s'.repeat(32)}`, 'Content-Type': 'application/json', ...extra },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json() };
  }
  const owner = { 'x-remote-tenant': 'openclaw1', 'x-remote-tenant-key': key };
  const create = async () => (await request('/sessions', { tenant: 'openclaw1' }, owner)).body;
  const unlock = async s => (await request(`/${s.id}/unlock`, { code: s.code })).body;
  return { request, create, unlock, transports, owner, advance: ms => { time += ms; }, revoke: () => { key = undefined; } };
}
test('only the enabled tenant can create a fixed workspace shell; reads require code redemption', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/health', undefined, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await f.request('/sessions', { tenant: 'openclaw2' }, f.owner)).status, 401);
  assert.equal((await f.request('/sessions', { tenant: 'openclaw1', command: 'anything' }, f.owner)).status, 400);
  const s = await f.create(); assert.match(s.url, /^https:\/\/8examples.com\/remote-terminal\//); assert.match(s.code, /^\d{6}$/);
  assert.equal((await f.request(`/${s.id}/output`)).status, 401);
  const u = await f.unlock(s); assert.equal(u.status, 'connected'); assert.equal(u.code, undefined);
  assert.equal((await f.request(`/${s.id}/unlock`, { code: s.code })).status, 410);
  assert.equal((await f.request(`/${s.id}/output`, undefined, { 'x-remote-viewer': u.viewerToken })).status, 200);
});
test('concurrent redemption has exactly one winner', async t => {
  const f = await fixture(t), s = await f.create();
  const results = await Promise.all(Array.from({ length: 8 }, () => f.request(`/${s.id}/unlock`, { code: s.code })));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(results.filter(r => r.status === 410).length, 7);
});
test('five incorrect codes lock and close the waiting shell', async t => {
  const f = await fixture(t), s = await f.create();
  const wrong = s.code === '000000' ? '000001' : '000000';
  for (let n = 0; n < 5; n++) assert.equal((await f.request(`/${s.id}/unlock`, { code: wrong })).status, 401);
  assert.equal((await f.request(`/${s.id}/unlock`, { code: s.code })).status, 410);
  assert.equal(f.transports[0].closed, true);
});
test('expiry, inactivity, reassignment, replacement and completion close the shell', async t => {
  for (const reason of ['expiry', 'idle', 'revoke', 'replacement', 'complete']) {
    const f = await fixture(t), s = await f.create(), u = await f.unlock(s);
    const headers = { 'x-remote-viewer': u.viewerToken };
    if (reason === 'expiry') f.advance(15 * 60000);
    if (reason === 'idle') f.advance(3 * 60000);
    if (reason === 'revoke') f.revoke();
    if (reason === 'replacement') await f.create();
    if (reason === 'complete') assert.equal((await f.request(`/${s.id}/complete`, {}, headers)).status, 200);
    assert.equal((await f.request(`/${s.id}/output`, undefined, headers)).status, 410, reason);
    assert.equal(f.transports[0].closed, true, reason);
  }
});
test('input is ordered and deduplicated, including simultaneous delivery; invalid payloads never reach the PTY', async t => {
  const f = await fixture(t), s = await f.create(), u = await f.unlock(s), headers = { 'x-remote-viewer': u.viewerToken };
  const input = { sequence: 1, data: Buffer.from('echo hello\r').toString('base64') };
  const requests = await Promise.all([f.request(`/${s.id}/input`, input, headers), f.request(`/${s.id}/input`, input, headers)]);
  assert(requests.every(r => r.status === 200)); assert.equal(f.transports[0].calls.length, 1);
  assert.equal((await f.request(`/${s.id}/input`, { ...input, sequence: 3 }, headers)).status, 409);
  assert.equal((await f.request(`/${s.id}/input`, { sequence: 2, data: 'not-base64' }, headers)).status, 400);
  assert.equal((await f.request(`/${s.id}/input`, { sequence: 2, data: Buffer.alloc(4097).toString('base64') }, headers)).status, 400);
  assert.equal((await f.request(`/${s.id}/resize`, { cols: 0, rows: 5000 }, headers)).status, 400);
  assert.equal((await f.request(`/${s.id}/resize`, { cols: 120, rows: 40 }, headers)).status, 200);
  assert.equal((await f.request(`/${s.id}/output?after=-1`, undefined, headers)).status, 400);
});
test('a slow creation does not issue a session after tenant access is revoked', async t => {
  let ready, closed = false;
  const f = await fixture(t, { createTransport: () => ({ ready: new Promise(resolve => { ready = resolve; }), close() { closed = true; } }) });
  const creation = f.request('/sessions', { tenant: 'openclaw1' }, f.owner);
  while (!ready) await new Promise(resolve => setTimeout(resolve, 5));
  f.revoke(); ready();
  assert.equal((await creation).status, 401); assert.equal(closed, true);
});
test('admin mode requires a redeemed owner connection, is scoped to its tenant, and closes the previous shell', async t => {
  const f = await fixture(t, { allowAdmin: tenant => tenant === 'openclaw1' });
  assert.equal((await f.request('/account/sessions', { tenant: 'openclaw2' })).status, 403);
  assert.equal((await f.request('/account/sessions', { tenant: 'openclaw1' }, { Authorization: 'Bearer wrong' })).status, 401);
  const session = (await f.request('/account/sessions', { tenant: 'openclaw1' })).body;
  assert.equal((await f.request(`/${session.id}/shell`, { mode: 'root' })).status, 401);
  const redeemed = await f.unlock(session), headers = { 'x-remote-viewer': redeemed.viewerToken };
  assert.equal((await f.request(`/${session.id}/shell`, { mode: 'root', tenant: 'openclaw2' }, headers)).status, 400);
  const switched = await f.request(`/${session.id}/shell`, { mode: 'root' }, headers);
  assert.equal(switched.status, 200); assert.equal(switched.body.mode, 'root'); assert.equal(switched.body.lastInputSequence, 0);
  assert.equal(f.transports[0].closed, true); assert.equal(f.transports[1].closed, false);
  const disabled = await fixture(t), second = await disabled.create(), u = await disabled.unlock(second);
  assert.equal((await disabled.request(`/${second.id}/shell`, { mode: 'root' }, { 'x-remote-viewer': u.viewerToken })).status, 403);
});
