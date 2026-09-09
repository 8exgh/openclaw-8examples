import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openInbox, bindOwner } from './plugin/store.mjs';
import { createInboxEngine } from './plugin/inbox.mjs';

const at = '2026-09-09T18:00:00Z';
const record = (id = 'call-one') => ({ id, direction: 'inbound', status: 'ended', startedAt: '2026-09-09T18:05:00Z', from: '+15555550123', to: '+15555550999', turns: [
  { role: 'caller', text: 'This is Joseph. Can Bill meet Wednesday September 16 at 10 a.m. America/Edmonton?' },
  { role: 'agent', text: 'I will ask Bill to confirm.' },
] });
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'phone-inbox-test-'));
  let store = openInbox(path.join(dir, 'inbox.sqlite'));
  const calls = [record()], delivered = [], mirrored = [], posted = [];
  let postFailure = false, mirrorFailure = false, deliveryFailure = false;
  const request = async (method, url, body) => {
    if (method === 'POST') {
      posted.push(body);
      if (postFailure) throw new Error('Synthetic lost acknowledgment');
      return { orchestrationId: 'callback-one' };
    }
    if (url.includes('?')) return calls;
    if (url.endsWith('/callback-one')) return { id: 'callback-one', status: 'ended', direction: 'outbound', startedAt: '2026-09-09T18:10:01Z', to: '+15555550123', turns: [{ role: 'caller', text: 'Confirmed.' }] };
    return calls.find(call => url.endsWith('/' + call.id));
  };
  const make = () => createInboxEngine({ store, request, activationAt: at, now: () => Date.parse('2026-09-09T18:10:00Z'),
    deliver: async body => { delivered.push(body); if (deliveryFailure) throw new Error('Synthetic timeout'); return { messageId: '123' }; },
    mirror: async body => { if (mirrorFailure) throw new Error('Synthetic closed transcript'); mirrored.push(body); },
  });
  let engine = make();
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { calls, delivered, mirrored, posted, get engine() { return engine; }, get store() { return store; },
    restart() { store.close(); store = openInbox(path.join(dir, 'inbox.sqlite')); engine = make(); },
    failPost() { postFailure = true; }, failDelivery() { deliveryFailure = true; }, failMirror(value) { mirrorFailure = value; },
  };
}
test('incoming phone context reaches the owner, survives restart, and resumes one verified callback', async t => {
  const f = fixture(t);
  await Promise.all([f.engine.sync(), f.engine.sync()]);
  assert.equal(f.delivered.length, 1); assert.match(f.delivered[0], /September 16/); assert.equal(f.mirrored.length, 1);
  f.restart(); await f.engine.sync();
  assert.equal(f.delivered.length, 1); assert.match(JSON.stringify(f.engine.context()), /America\/Edmonton/);
  await f.engine.tool({ action: 'publish', callId: 'call-one', summary: 'Joseph proposes a meeting', proposedTime: '2026-09-16T10:00:00', timezone: 'America/Edmonton' });
  await f.engine.tool({ action: 'callback', callId: 'call-one', goal: 'Bill confirms the proposed meeting' }, { owner: true });
  f.restart();
  const repeated = await f.engine.tool({ action: 'callback', callId: 'call-one', goal: 'Repeat' }, { owner: true });
  assert.equal(repeated.repeated, true); assert.equal(f.posted.length, 1);
  await f.engine.tool({ action: 'complete', callId: 'call-one', outcome: 'Joseph confirmed the meeting on the callback.' }, { owner: true });
  assert.equal((await f.engine.tool({ action: 'callback', callId: 'call-one', goal: 'Repeat' }, { owner: true })).status, 'already_resolved');
  assert.equal(f.posted.length, 1);
});
test('unknown callbacks survive restart without replay and can be reconciled to phone history', async t => {
  const f = fixture(t); await f.engine.sync(); f.failPost();
  assert.equal((await f.engine.tool({ action: 'callback', callId: 'call-one', goal: 'Confirm' }, { owner: true })).status, 'unknown');
  f.restart();
  assert.equal((await f.engine.tool({ action: 'callback', callId: 'call-one', goal: 'Confirm' }, { owner: true })).status, 'unknown');
  assert.equal(f.posted.length, 1);
  await assert.rejects(f.engine.tool({ action: 'complete', callId: 'call-one', outcome: 'Done' }, { owner: true }), /uncertain/);
  await f.engine.tool({ action: 'reconcile', callId: 'call-one', callbackId: 'callback-one' }, { owner: true });
  await f.engine.tool({ action: 'complete', callId: 'call-one', outcome: 'Verified' }, { owner: true });
});
test('several pending calls require a specific owner selection; background sessions cannot callback', async t => {
  const f = fixture(t); f.calls.push(record('call-two')); await f.engine.sync();
  await assert.rejects(f.engine.tool({ action: 'callback', callId: 'call-one', goal: 'Confirm' }, { owner: true }), /Several calls/);
  await assert.rejects(f.engine.tool({ action: 'callback', callId: 'call-one', goal: 'Confirm' }), /owner/);
  assert.equal(f.posted.length, 0);
  await f.engine.tool({ action: 'callback', callId: 'call-one', goal: 'Confirm' }, { owner: true, selectedCallId: 'call-one' });
  assert.equal(f.posted.length, 1);
});
test('notification failures preserve context; a successful notification is not resent while mirroring recovers', async t => {
  const f = fixture(t); f.failMirror(true); await f.engine.sync();
  assert.equal(f.delivered.length, 1); assert.equal(f.mirrored.length, 0);
  f.restart(); f.failMirror(false); await f.engine.sync();
  assert.equal(f.delivered.length, 1); assert.equal(f.mirrored.length, 1);
  f.calls.push(record('call-two')); f.failDelivery(); await f.engine.sync(); f.restart(); await f.engine.sync();
  assert.equal(f.delivered.length, 2); assert.equal(f.engine.context().pendingCount, 2);
});
test('historical calls are available as references without notifying the owner again', async t => {
  const f = fixture(t); f.calls[0].startedAt = '2026-09-08T18:00:00Z'; await f.engine.sync();
  assert.equal(f.delivered.length, 0); assert.equal(f.engine.context().calls[0].status, 'reference');
});
test('reassigning an owner blocks old saved and gateway history even when the phone credential is reused', async t => {
  const f = fixture(t); await f.engine.sync();
  const dir = mkdtempSync(path.join(tmpdir(), 'phone-owner-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binding = path.join(dir, 'owner.sqlite'), now = Date.parse('2026-09-09T18:10:00Z');
  assert.equal(bindOwner(binding, 'owner-a', now), '1970-01-01T00:00:00.000Z');
  const since = bindOwner(binding, 'owner-b', now);
  assert.equal(since, new Date(now).toISOString()); assert.equal(bindOwner(binding, 'owner-b', now + 10000), since);
  const engine = createInboxEngine({ store: f.store, historyNotBefore: since, now: () => now,
    request: async () => f.calls, deliver: async () => { throw new Error('Must not notify about a prior owner’s call'); } });
  await engine.sync(); assert.equal(engine.context().calls.length, 0);
  await assert.rejects(engine.tool({ action: 'read', callId: 'call-one' }), /not found/);
  assert.equal(bindOwner(binding, 'owner-a', now + 20000), new Date(now + 20000).toISOString());
});
