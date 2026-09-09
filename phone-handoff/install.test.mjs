import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installPhoneHandoff, privateOwner } from './install.mjs';
const tenant = { id: 'example', channel: 'telegram', capabilities: { phone: { enabled: true } }, telegramAllowFrom: ['telegram:777'] };
const config = () => ({ session: { dmScope: 'per-channel-peer' }, channels: { telegram: { enabled: true, dmPolicy: 'allowlist', allowFrom: ['telegram:777'] } }, plugins: { entries: { existing: { enabled: true } }, allow: ['existing'], load: { paths: ['/existing'] } } });
test('only a unique configured private owner can receive phone context', () => {
  assert.equal(privateOwner(tenant, config()).peer, '777');
  for (const peers of [['*'], ['-123'], ['777', '888'], ['888']]) {
    const c = config(); c.channels.telegram.allowFrom = peers; assert.equal(privateOwner(tenant, c), undefined);
  }
  for (const update of [{ offboardedAt: 'now' }, { modelAccess: 'suppressed' }, { capabilities: {} }]) assert.equal(privateOwner({ ...tenant, ...update }, config()), undefined);
  const c = config(); c.session.dmScope = 'main'; assert.equal(privateOwner(tenant, c), undefined);
});
test('installation preserves config and personal instructions, is repeatable, and disables on release', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'phone-install-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'config')); mkdirSync(path.join(dir, 'workspace'));
  const file = path.join(dir, 'config/openclaw.json'), agents = path.join(dir, 'workspace/AGENTS.md');
  writeFileSync(file, JSON.stringify(config())); writeFileSync(agents, 'Owner’s personal instructions.\n');
  assert.equal(installPhoneHandoff(dir, tenant).enabled, true);
  assert.equal(installPhoneHandoff(dir, tenant).changed, false);
  const installed = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(installed.channels, config().channels); assert.deepEqual(installed.plugins.entries.existing, { enabled: true });
  assert.equal(installed.plugins.load.paths.length, 2);
  assert.equal(readFileSync(agents, 'utf8').split('<!-- managed-phone-handoff:start -->').length, 2);
  installPhoneHandoff(dir, { ...tenant, offboardedAt: 'now' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), config());
  assert.equal(readFileSync(agents, 'utf8'), 'Owner’s personal instructions.\n');
});
