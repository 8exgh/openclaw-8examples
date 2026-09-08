import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderAgentInstructions, renderTenant } from '../src/provisioner/render.js';
import type { Tenant } from '../src/types.js';

test('every container Claw gets a working helper, scoped credential, and persistent contextual guidance', (t) => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'remote-awareness-'));
  const oldRoot = process.env.MOC_TENANTS_DIR;
  process.env.MOC_TENANTS_DIR = scratch;
  t.after(() => {
    if (oldRoot === undefined) delete process.env.MOC_TENANTS_DIR;
    else process.env.MOC_TENANTS_DIR = oldRoot;
    rmSync(scratch, { recursive: true, force: true });
  });
  const tenant: Tenant = { id: 'remote-test', name: 'Remote Test', contact: {}, channel: 'whatsapp', gatewayPort: 29990,
    tier: 'container', createdAt: new Date().toISOString(), capabilities: {}, nudgeLog: [] };
  const fleet = { releaseChannel: 'latest' as const, image: 'test/image', nextPort: 1 };
  const dir = path.join(scratch, tenant.id);
  renderTenant(tenant, fleet);
  const key = readFileSync(path.join(dir, '.remote-connect-key'), 'utf8').trim();
  assert.match(key, /^[0-9a-f]{64}$/);
  const account = JSON.parse(readFileSync(path.join(dir, 'workspace/remote-connect/account.json'), 'utf8'));
  assert.equal(account.token, key);
  assert.equal(account.tenant, tenant.id);
  assert.equal(account.origin, 'https://8examples.com');
  assert.equal(statSync(path.join(dir, 'workspace/remote-connect/account.json')).mode & 0o777, 0o600);
  renderTenant(tenant, fleet);
  renderAgentInstructions(tenant); // phone/mailbox refreshes must retain guidance too
  assert.equal(readFileSync(path.join(dir, '.remote-connect-key'), 'utf8').trim(), key);
  const agents = readFileSync(path.join(dir, 'workspace/AGENTS.md'), 'utf8');
  assert.equal(agents.match(/managed-remote-connect:start/g)?.length, 1);
  assert.match(agents, /node remote-connect\/session.mjs create <targetId>/);
  assert.match(agents, /Pause browser actions, screenshots/);
  assert.match(agents, /Old portal links in conversation\s+history are obsolete/);
  assert.match(agents, /Never send `127\.0\.0\.1`, `localhost`/);
  assert.ok(!agents.includes(key));
  assert.match(readFileSync(path.join(dir, 'workspace/skills/remote-login/SKILL.md'), 'utf8'), /password entry, MFA, CAPTCHA/);
});
