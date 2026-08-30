import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { renderTenant } from '../src/provisioner/render.js';
import type { Fleet, Tenant } from '../src/types.js';

// The renderer uses the repository tenant root, so exercise the public behavior
// through an isolated tenant id and always clean it up.
const fleet: Fleet = { releaseChannel: 'latest', image: 'test/image', nextPort: 1 };

test('new and explicitly unassigned tenants do not receive model credentials', () => {
  const id = `test-suppressed-${Date.now()}`;
  const tenant: Tenant = { id, name: id, contact: {}, channel: 'whatsapp', gatewayPort: 29991,
    tier: 'container', createdAt: new Date().toISOString(), modelAccess: 'suppressed', capabilities: {}, nudgeLog: [] };
  try {
    process.env.ANTHROPIC_API_KEY = 'anthropic-secret';
    process.env.KIMI_API_KEY = 'kimi-secret';
    renderTenant(tenant, fleet);
    const env = readFileSync(path.join(process.cwd(), 'tenants', id, '.env'), 'utf8');
    assert.doesNotMatch(env, /ANTHROPIC_API_KEY|KIMI_API_KEY/);
  } finally {
    rmSync(path.join(process.cwd(), 'tenants', id), { recursive: true, force: true });
  }
});

test('assigned and legacy tenants retain model access', () => {
  for (const modelAccess of ['assigned', undefined] as const) {
    const id = `test-assigned-${modelAccess ?? 'legacy'}-${Date.now()}`;
    const tenant: Tenant = { id, name: id, contact: {}, channel: 'whatsapp', gatewayPort: 29992,
      tier: 'container', createdAt: new Date().toISOString(), modelAccess, capabilities: {}, nudgeLog: [] };
    try {
      process.env.ANTHROPIC_API_KEY = 'anthropic-secret';
      process.env.KIMI_API_KEY = 'kimi-secret';
      renderTenant(tenant, fleet);
      const env = readFileSync(path.join(process.cwd(), 'tenants', id, '.env'), 'utf8');
      assert.match(env, /ANTHROPIC_API_KEY=anthropic-secret/);
      assert.match(env, /KIMI_API_KEY=kimi-secret/);
    } finally {
      rmSync(path.join(process.cwd(), 'tenants', id), { recursive: true, force: true });
    }
  }
});

test('suppression escrows existing credentials and assignment restores them', () => {
  const id = `test-restore-${Date.now()}`;
  const tenant: Tenant = { id, name: id, contact: {}, channel: 'whatsapp', gatewayPort: 29993,
    tier: 'container', createdAt: new Date().toISOString(), capabilities: {}, nudgeLog: [] };
  const dir = path.join(process.cwd(), 'tenants', id);
  try {
    process.env.ANTHROPIC_API_KEY = 'anthropic-existing';
    process.env.KIMI_API_KEY = 'kimi-existing';
    renderTenant(tenant, fleet);
    tenant.modelAccess = 'suppressed';
    renderTenant(tenant, fleet);
    assert.doesNotMatch(readFileSync(path.join(dir, '.env'), 'utf8'), /ANTHROPIC_API_KEY|KIMI_API_KEY/);
    assert.match(readFileSync(path.join(dir, '.model-credentials.env'), 'utf8'), /ANTHROPIC_API_KEY=anthropic-existing/);

    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.KIMI_API_KEY;
    tenant.modelAccess = 'assigned';
    renderTenant(tenant, fleet);
    const restored = readFileSync(path.join(dir, '.env'), 'utf8');
    assert.match(restored, /ANTHROPIC_API_KEY=anthropic-existing/);
    assert.match(restored, /KIMI_API_KEY=kimi-existing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
