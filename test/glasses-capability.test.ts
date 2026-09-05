import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderTenant } from '../src/provisioner/render.js';
import type { Tenant } from '../src/types.js';

test('enabling glasses installs the summary integration and disabling preserves agent-owned history', (t) => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'glasses-capability-'));
  const old = process.env.MOC_TENANTS_DIR;
  process.env.MOC_TENANTS_DIR = scratch;
  t.after(() => {
    if (old === undefined) delete process.env.MOC_TENANTS_DIR; else process.env.MOC_TENANTS_DIR = old;
    rmSync(scratch, { recursive: true, force: true });
  });
  const tenant: Tenant = { id: 'glasses-test', name: 'Glasses Test', contact: {}, channel: 'telegram',
    gatewayPort: 29994, createdAt: new Date().toISOString(), capabilities: {}, nudgeLog: [] };
  const fleet = { releaseChannel: 'latest' as const, image: 'test/image:latest', nextPort: 1 };
  const dir = path.join(scratch, tenant.id);
  const workspace = path.join(dir, 'workspace');
  renderTenant(tenant, fleet);
  assert.equal(existsSync(path.join(workspace, 'glasses/publish-summary.mjs')), false);
  tenant.capabilities.glasses = { enabled: true };
  renderTenant(tenant, fleet);
  assert.match(readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'), /Meta glasses/);
  assert.match(readFileSync(path.join(workspace, 'capabilities/glasses.md'), 'utf8'), /same id and content/);
  assert.match(readFileSync(path.join(workspace, 'glasses/publish-summary.mjs'), 'utf8'), /process.env.GLASSES_RELAY_TOKEN/);
  assert.match(readFileSync(path.join(dir, '.env'), 'utf8'), /GLASSES_RELAY_TOKEN=changeme/);
  writeFileSync(path.join(workspace, 'glasses/PENDING.md'), 'An existing task');
  tenant.capabilities.glasses = { enabled: false };
  renderTenant(tenant, fleet);
  assert.equal(existsSync(path.join(workspace, 'glasses/publish-summary.mjs')), false);
  assert.equal(existsSync(path.join(workspace, 'capabilities/glasses.md')), false);
  assert.equal(readFileSync(path.join(workspace, 'glasses/PENDING.md'), 'utf8'), 'An existing task');
});
