// Post-upgrade checks through the installed CLI. Never delivers chat messages.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
const exec = promisify(execFile);
const root = process.env.MOC_ROOT;
if (!root) throw new Error('MOC_ROOT is required');
const cli = async args => {
  const { stdout } = await exec('docker', ['exec', '--user', 'node', 'openclaw-openclaw1', 'openclaw', ...args], { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
};
const config = JSON.parse(readFileSync(path.join(root, 'tenants/openclaw1/config/openclaw.json'), 'utf8'));
const expected = Object.entries(config.plugins?.entries || {}).filter(([, entry]) => entry.enabled === true).map(([id]) => id);
const inventory = await cli(['plugins', 'list', '--json']);
for (const id of expected) assert(inventory.plugins?.some(p => p.id === id && p.status === 'loaded'), `Enabled plugin is not loaded: ${id}`);
console.log(`PASS: all ${expected.length} explicitly enabled plugins load on the installed release.`);
const health = await cli(['health', '--json']);
assert.equal(health.ok, true, 'Gateway health');
for (const [channel, status] of Object.entries(health.channels || {})) {
  if (!status.configured) continue;
  assert.notEqual(status.probe?.ok, false, `Configured channel probe failed: ${channel}`);
  console.log(JSON.stringify({ channel, configured: status.configured, probeOk: status.probe?.ok }));
}
const marker = 'UPGRADE_READY_' + randomUUID().replaceAll('-', '');
const response = await cli(['agent', '--agent', 'main', '--session-key', `agent:main:upgrade-check:${randomUUID()}`, '--message', `Reply with exactly ${marker}. Do not use tools, contact anyone, or perform any other task.`, '--timeout', '120', '--json']);
const reply = (response.result?.payloads || response.payloads || []).map(p => p.text || '').join('\n');
assert(reply.includes(marker), 'A normal model-backed agent turn must return the requested proof');
console.log('PASS: a fresh private agent turn received a real model reply; no message was delivered to chat.');
