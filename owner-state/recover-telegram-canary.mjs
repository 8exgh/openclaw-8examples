// Recover the owner's canary from a disposed in-memory transcript attempt.
// Restart the existing container: no provisioning, reset, or synthetic chat send.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertOwnerIdle } from './index.mjs';

const root = process.env.MOC_ROOT;
assert(root, 'MOC_ROOT required');
const dir = path.join(root, 'tenants/openclaw1');
const name = 'openclaw-openclaw1';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const cli = args => JSON.parse(docker(['exec', '--user', 'node', name, 'openclaw', ...args]));
const status = () => {
  const value = cli(['channels', 'status', '--channel', 'telegram', '--probe', '--json']);
  return value.channelAccounts?.telegram?.find(a => a.accountId === 'default');
};
const summary = value => ({ running: value?.running, connected: value?.connected, lifecycle: value?.lifecycle, probeOk: value?.probe?.ok, lastInboundAt: value?.lastInboundAt, lastOutboundAt: value?.lastOutboundAt });
const logs = since => {
  const result = spawnSync('docker', ['logs', '--since', since, name], { encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, 'Read bounded gateway logs');
  return (result.stdout || '') + (result.stderr || '');
};
const fleet = () => {
  const ids = docker(['ps', '-aq', '--filter', 'name=openclaw-']).split('\n').filter(Boolean);
  return JSON.parse(docker(['inspect', ...ids])).filter(c => c.Name !== '/' + name).map(c => ({ id: c.Id, start: c.State.StartedAt })).sort((a, b) => a.id.localeCompare(b.id));
};
const fingerprints = () => Object.fromEntries(['config/openclaw.json', 'workspace/AGENTS.md', 'workspace/SOUL.md', 'workspace/USER.md', 'workspace/HEARTBEAT.md', 'workspace/TOOLS.md'].map(file => [file, existsSync(path.join(dir, file)) ? createHash('sha256').update(readFileSync(path.join(dir, file))).digest('hex') : null]));

const before = status();
console.log(JSON.stringify({ before: summary(before), disposedAttemptErrors: (logs('3h').match(/attempt disposed before transcript write/g) || []).length }));
if (process.env.OPENCLAW_TELEGRAM_RESTART !== '1') process.exit(0);
assertOwnerIdle(dir);
assert(logs('3h').includes('attempt disposed before transcript write'), 'Only recover the diagnosed disposed-attempt failure');
const original = JSON.parse(docker(['inspect', name]))[0];
const fleetBefore = fleet(), filesBefore = fingerprints();
const since = new Date().toISOString();
docker(['restart', '--time', '30', name]);
let after;
for (let n = 0; n < 45; n++) {
  try { after = status(); if (after?.running && after.connected && after.probe?.ok) break; } catch {}
  await new Promise(resolve => setTimeout(resolve, 2000));
}
assert.equal(after?.running, true, 'Telegram listener running');
assert.equal(after?.connected, true, 'Telegram connected');
assert.equal(after?.probe?.ok, true, 'Telegram API probe succeeds');
const current = JSON.parse(docker(['inspect', name]))[0];
assert.equal(current.Id, original.Id, 'Existing owner container retained');
assert.equal(current.Image, original.Image, 'Owner system image retained');
assert.deepEqual(fingerprints(), filesBefore, 'Owner configuration and instructions retained');
assert.deepEqual(fleet(), fleetBefore, 'Other Claws unchanged');
console.log('PASS: restarted only the existing openclaw1 container; owner configuration, instructions, filesystem and other Claws retained.');
// Observe the normal retry of the owner's already-queued message. Never inject one.
for (let n = 0; n < 60; n++) {
  await new Promise(resolve => setTimeout(resolve, 3000));
  const recent = logs(since);
  assert(!recent.includes('attempt disposed before transcript write'), 'Disposed-attempt failure returned after restart');
  after = status();
  if (after?.lastOutboundAt && after.lastOutboundAt > Date.parse(since)) {
    console.log(JSON.stringify({ after: summary(after), ownerMessageReplyObserved: true }));
    console.log('PASS: the normal Telegram pipeline sent a reply after recovery.');
    process.exit(0);
  }
}
console.log(JSON.stringify({ after: summary(after), ownerMessageReplyObserved: false }));
throw new Error('Telegram recovered but no normal outbound reply observed within the verification window');
