import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { Store } from '../server/store.mjs';
import { httpError, mobileIdentity, vault } from '../server/security.mjs';
import { deliverPushes, dockerRunner, parseAgentOutput, runOne } from '../server/worker.mjs';
import { apnsPayload, createAPNs } from '../server/apns.mjs';

const first = `mob_${'1'.repeat(64)}`, second = `mob_${'2'.repeat(64)}`;
const renewed = `mob_${'4'.repeat(64)}`;
const publisher = `gws_${'3'.repeat(64)}`;
const credentials = vault('a'.repeat(64));
const deviceToken = 'b'.repeat(64);
const user = (name) => ({ username: name, claws: [{ clawId: name }] });
async function authenticate(token) {
  if (token === first || token === renewed) return user('openclaw1');
  if (token === second) return user('openclaw2');
  throw httpError(401, 'Sign in again');
}
async function fixture(t, options = {}) {
  const store = new Store(':memory:');
  const app = createApp({ store, authenticate, vault: credentials, publishers: { openclaw1: publisher }, pushEnabled: true, ...options });
  t.after(async () => { await app.close(); store.close(); });
  const request = (method, url, body, token = first) => app.inject({ method, url,
    headers: { authorization: `Bearer ${token}` }, ...(body ? { payload: body } : {}) });
  return { app, store, request };
}

test('a glasses request reaches only its owned claw and returns one durable reply after HTTP retries', async (t) => {
  const { store, request } = await fixture(t);
  const body = { requestId: 'request-1', clawId: 'openclaw1', text: 'Tell me whether the table was booked.' };
  assert.equal((await request('POST', '/v1/requests', body)).statusCode, 202);
  assert.equal((await request('POST', '/v1/requests', body)).statusCode, 202);
  assert.equal((await request('POST', '/v1/requests', { ...body, text: 'Different task' })).statusCode, 409);
  let calls = 0;
  const context = { store, authenticate, vault: credentials, runAgent: async (job) => {
    calls++; assert.equal(job.claw_id, 'openclaw1'); assert.equal(job.text, body.text);
    return 'The table is booked for 7 pm. The confirmation is saved.';
  } };
  assert.equal(await runOne(context), true);
  assert.equal(await runOne(context), false);
  assert.equal(calls, 1);
  const inbox = (await request('GET', '/v1/events?clawId=openclaw1')).json();
  assert.equal(inbox.events.length, 1);
  assert.equal(inbox.events[0].kind, 'replied');
  assert.match(inbox.events[0].summary, /7 pm/);
  assert.equal((await request('GET', `/v1/events?clawId=openclaw1&after=${inbox.cursor}`)).json().events.length, 0);
  assert.equal((await request('POST', '/v1/requests', body)).json().status, 'replied');
  assert.equal((await request('GET', '/v1/events?clawId=openclaw1', undefined, second)).statusCode, 403);
  assert.equal((await request('POST', '/v1/requests', { ...body, clawId: 'openclaw2' })).statusCode, 403);
  assert.equal((await request('GET', '/v1/me', undefined, 'wrong')).statusCode, 401);
  assert.equal((await request('POST', '/v1/requests', { ...body, clawId: '../openclaw2' })).statusCode, 400);
});

test('proactive summaries require the matching claw publisher and deduplicate by action id', async (t) => {
  const { request } = await fixture(t);
  const summary = { actionId: 'booking-123', clawId: 'openclaw1', summary: 'Your booking is confirmed.', detail: 'Two people at 7 pm.' };
  assert.equal((await request('POST', '/v1/summaries', summary)).statusCode, 401);
  assert.equal((await request('POST', '/v1/summaries', { ...summary, clawId: 'openclaw2' }, publisher)).statusCode, 401);
  const created = await request('POST', '/v1/summaries', summary, publisher);
  assert.equal(created.statusCode, 201);
  assert.deepEqual((await request('POST', '/v1/summaries', summary, publisher)).json(), created.json());
  assert.equal((await request('POST', '/v1/summaries', { ...summary, summary: 'Changed' }, publisher)).statusCode, 409);
  assert.equal((await request('GET', '/v1/events?clawId=openclaw1')).json().events.length, 1);
  assert.equal((await request('GET', '/v1/events?clawId=openclaw2', undefined, second)).json().events.length, 0);
});

test('a crash or ambiguous agent failure never repeats an action and encrypted sessions survive restart', async (t) => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'glasses-restart-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const filename = path.join(scratch, 'state.sqlite');
  let store = new Store(filename);
  store.enqueue({ id: 'one', username: 'openclaw1', clawId: 'openclaw1', text: 'Perform an action', credential: credentials.seal(first) });
  assert.equal(store.claim().id, 'one');
  store.close();
  assert.ok(!readFileSync(filename).includes(Buffer.from(first)));
  store = new Store(filename);
  t.after(() => store.close());
  assert.equal(store.recoverInterrupted(), 1);
  assert.equal(store.claim(), undefined);
  assert.equal(store.events('openclaw1', 'openclaw1').events[0].kind, 'uncertain');
  store.enqueue({ id: 'two', username: 'openclaw1', clawId: 'openclaw1', text: 'Another action', credential: credentials.seal(first) });
  let calls = 0;
  const context = { store, authenticate, vault: credentials, runAgent: async () => { calls++; throw new Error('Timed out after side effect'); } };
  await runOne(context);
  await runOne(context);
  assert.equal(calls, 1);
  assert.equal(store.events('openclaw1', 'openclaw1').events.at(-1).kind, 'uncertain');
});

test('revoked account access stops queued execution', async (t) => {
  const { store, request } = await fixture(t);
  await request('POST', '/v1/requests', { requestId: 'one', clawId: 'openclaw1', text: 'Please act' });
  let executed = false;
  await runOne({ store, vault: credentials, authenticate: async () => { throw httpError(401, 'Revoked'); },
    runAgent: async () => { executed = true; return 'Done'; } });
  assert.equal(executed, false);
  assert.equal(store.events('openclaw1', 'openclaw1').events[0].kind, 'failed');
});

test('push delivery checks current ownership, survives device refresh, retries independently, and removes revoked devices', async (t) => {
  const { store, request } = await fixture(t);
  const device = { installationId: 'phone-1', deviceToken };
  await request('POST', '/v1/devices', device);
  await request('POST', '/v1/devices', { installationId: 'phone-2', deviceToken: 'c'.repeat(64) }, second);
  await request('POST', '/v1/summaries', { actionId: 'action-1', clawId: 'openclaw1', summary: 'Your work is done.' }, publisher);
  await request('POST', '/v1/devices', device); // Refresh must not discard the outbox.
  const sent = [];
  await deliverPushes({ store, authenticate, vault: credentials, push: async (item) => sent.push(item.token) });
  assert.deepEqual(sent, [deviceToken]);
  assert.equal(store.pendingPushes().length, 0);
  await request('POST', '/v1/summaries', { actionId: 'action-2', clawId: 'openclaw1', summary: 'A second result.' }, publisher);
  await deliverPushes({ store, authenticate, vault: credentials, push: async () => { throw new Error('Network down'); } });
  assert.equal(store.pendingPushes().length, 0); // Backoff, not discarded.
  store.db.prepare('UPDATE outbox SET next_at=0').run();
  assert.equal(store.pendingPushes()[0].attempts, 1);
  await deliverPushes({ store, vault: credentials, authenticate: async () => { throw httpError(401, 'Revoked'); }, push: async () => assert.fail('Must not push') });
  assert.equal(store.pendingPushes().length, 0);
  assert.equal(store.db.prepare("SELECT * FROM devices WHERE id='phone-1'").get(), undefined);
});

test('unregistering a device stops its pending summaries', async (t) => {
  const { store, request } = await fixture(t);
  await request('POST', '/v1/devices', { installationId: 'phone-1', deviceToken });
  await request('POST', '/v1/summaries', { actionId: 'action-1', clawId: 'openclaw1', summary: 'Done.' }, publisher);
  await request('DELETE', '/v1/devices/phone-1', undefined, second);
  assert.equal(store.pendingPushes().length, 1);
  await request('DELETE', '/v1/devices/phone-1');
  assert.equal(store.pendingPushes().length, 0);
});

test('a late logout cannot remove the same iPhone subscription after a new login', async (t) => {
  const { store, request } = await fixture(t);
  const device = { installationId: 'shared-iphone', deviceToken };
  await request('POST', '/v1/devices', device);
  await request('POST', '/v1/devices', device, renewed);
  await request('DELETE', '/v1/devices/shared-iphone');
  await request('POST', '/v1/summaries', { actionId: 'new-session-summary', clawId: 'openclaw1', summary: 'A new result.' }, publisher);
  const sent = [];
  await deliverPushes({ store, authenticate, vault: credentials, push: async (item) => sent.push(item.token) });
  assert.deepEqual(sent, [deviceToken]);
  await request('DELETE', '/v1/devices/shared-iphone', undefined, renewed);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM devices').get().n, 0);
});

test('docker runner keeps owner text in one argument, requires structured success, and rejects partial stdout on failure', async () => {
  const job = { claw_id: 'openclaw1', username: 'openclaw1', text: 'Literal $(touch /tmp/wrong); `date` and "quotes"' };
  const run = dockerRunner({ execute: (command, args, options, callback) => {
    assert.equal(command, 'docker');
    assert.ok(!args.includes('--deliver'));
    assert.equal(args[args.indexOf('--session-key') + 1], 'glasses:openclaw1:openclaw1');
    assert.ok(args[args.indexOf('--message') + 1].endsWith(job.text));
    callback(null, JSON.stringify({ status: 'ok', result: { payloads: [{ text: 'Verified result.' }] } }));
  } });
  assert.equal(await run(job), 'Verified result.');
  const failed = dockerRunner({ execute: (_command, _args, _options, callback) => callback(new Error('timeout'), '{"status":"ok","payloads":[{"text":"Done"}]}') });
  await assert.rejects(failed(job), /did not finish/);
  assert.throws(() => parseAgentOutput('{"status":"error","payloads":[{"text":"Failed"}]}'));
  assert.throws(() => parseAgentOutput('{"status":"ok","result":{"payloads":[]}}'));
});

test('identity checks reject redirects/invalid tokens and vault/APNs do not expose session tokens', async () => {
  const sealed = credentials.seal(first);
  assert.equal(credentials.open(sealed), first);
  assert.ok(!sealed.includes(first));
  assert.throws(() => vault('bad'));
  const authenticate = mobileIdentity('https://8examples.com', async (url, init) => {
    assert.equal(url.href, 'https://8examples.com/api/mobile/queries/me');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${first}`);
    return new Response(JSON.stringify(user('openclaw1')));
  });
  assert.equal((await authenticate(first)).username, 'openclaw1');
  await assert.rejects(authenticate('***'), /Sign in/);
  assert.throws(() => mobileIdentity('http://example.com'), /HTTPS/);
  assert.throws(() => createAPNs({}), /Configure/);
  const notification = JSON.stringify(apnsPayload({ summary: 'A result.', claw_id: 'openclaw1', event_seq: 4, credential: first }));
  assert.ok(!notification.includes(first));
  assert.equal(JSON.parse(notification).aps.alert.body, 'A result.');
});

test('APNs signs a valid P-256 token and sends the correct topic, environment, payload and stable delivery id', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  let status = 200;
  const item = { token: deviceToken, apns_id: '1952b3cd-2061-42f2-9510-dc03b97f2b03', event_seq: 7,
    claw_id: 'openclaw1', summary: 'Your task finished.', created_at: Date.now() };
  const push = createAPNs({ teamId: 'AB12345678', keyId: 'CD12345678',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), topic: 'ai-assistant.8examples.com', environment: 'sandbox',
    connectImpl: (origin) => {
      assert.equal(origin, 'https://api.sandbox.push.apple.com');
      const session = new EventEmitter();
      session.setTimeout = () => {};
      session.destroy = () => {};
      session.request = (headers) => {
        assert.equal(headers[':path'], `/3/device/${deviceToken}`);
        assert.equal(headers['apns-topic'], 'ai-assistant.8examples.com');
        assert.equal(headers['apns-push-type'], 'alert');
        assert.equal(headers['apns-id'], item.apns_id);
        const parts = headers.authorization.slice('bearer '.length).split('.');
        assert.equal(JSON.parse(Buffer.from(parts[0], 'base64url')).alg, 'ES256');
        assert.equal(JSON.parse(Buffer.from(parts[1], 'base64url')).iss, 'AB12345678');
        assert.equal(verify('sha256', Buffer.from(parts.slice(0, 2).join('.')),
          { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url')), true);
        const stream = new EventEmitter();
        stream.setEncoding = () => {};
        stream.end = (body) => {
          assert.equal(JSON.parse(body).aps.alert.body, item.summary);
          assert.ok(Buffer.byteLength(body) < 4096);
          queueMicrotask(() => {
            stream.emit('response', { ':status': status });
            if (status === 410) stream.emit('data', '{"reason":"Unregistered"}');
            stream.emit('end');
          });
        };
        return stream;
      };
      return session;
    },
  });
  await push(item);
  status = 410;
  await assert.rejects(push(item), (error) => error.invalidDevice === true);
});
