import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildOpenclawConfig, renderTenant } from '../src/provisioner/render.js';
import type { Fleet, Tenant } from '../src/types.js';

// The renderer uses the repository tenant root, so exercise the public behavior
// through an isolated tenant id and always clean it up.
const fleet: Fleet = { releaseChannel: 'latest', image: 'test/image', nextPort: 1 };

test('MiniMax is appended as the fourth model only when its credential is ready', () => {
  const tenant: Tenant = { id: 'test-config', name: 'test-config', contact: {}, channel: 'whatsapp', gatewayPort: 29990,
    tier: 'container', createdAt: new Date().toISOString(), modelAccess: 'assigned', capabilities: {}, nudgeLog: [] };
  const withoutMiniMax = buildOpenclawConfig(tenant);
  assert.deepEqual(
    (withoutMiniMax.agents as any).defaults.model.fallbacks,
    ['openai/gpt-5.6-sol', 'kimi/k3'],
  );
  const withMiniMax = buildOpenclawConfig(tenant, { minimaxReady: true });
  assert.deepEqual(
    (withMiniMax.agents as any).defaults.model.fallbacks,
    ['openai/gpt-5.6-sol', 'kimi/k3', 'minimax/MiniMax-M3'],
  );
});

test('new and explicitly unassigned tenants do not receive model credentials', () => {
  const id = `test-suppressed-${Date.now()}`;
  const tenant: Tenant = { id, name: id, contact: {}, channel: 'whatsapp', gatewayPort: 29991,
    tier: 'container', createdAt: new Date().toISOString(), modelAccess: 'suppressed', capabilities: {}, nudgeLog: [] };
  try {
    process.env.ANTHROPIC_API_KEY = 'anthropic-secret';
    process.env.KIMI_API_KEY = 'kimi-secret';
    process.env.MINIMAX_API_KEY = 'minimax-secret';
    renderTenant(tenant, fleet);
    const env = readFileSync(path.join(process.cwd(), 'tenants', id, '.env'), 'utf8');
    assert.doesNotMatch(env, /ANTHROPIC_API_KEY|KIMI_API_KEY|MINIMAX_API_KEY/);
    const config = JSON.parse(readFileSync(path.join(process.cwd(), 'tenants', id, 'config', 'openclaw.json'), 'utf8'));
    assert.deepEqual(config.agents.defaults.model.fallbacks, ['openai/gpt-5.6-sol', 'kimi/k3']);
    assert.match(readFileSync(path.join(process.cwd(), 'tenants', id, '.model-credentials.env'), 'utf8'), /MINIMAX_API_KEY=minimax-secret/);
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
      process.env.MINIMAX_API_KEY = 'minimax-secret';
      renderTenant(tenant, fleet);
      const env = readFileSync(path.join(process.cwd(), 'tenants', id, '.env'), 'utf8');
      assert.match(env, /ANTHROPIC_API_KEY=anthropic-secret/);
      assert.match(env, /KIMI_API_KEY=kimi-secret/);
      assert.match(env, /MINIMAX_API_KEY=minimax-secret/);
      const config = JSON.parse(readFileSync(path.join(process.cwd(), 'tenants', id, 'config', 'openclaw.json'), 'utf8'));
      assert.deepEqual(config.agents.defaults.model.fallbacks, [
        'openai/gpt-5.6-sol',
        'kimi/k3',
        'minimax/MiniMax-M3',
      ]);
      assert.equal(config.plugins.entries.minimax.enabled, true);
      assert.equal(config.models.providers.minimax.api, 'anthropic-messages');
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
    process.env.MINIMAX_API_KEY = 'minimax-existing';
    renderTenant(tenant, fleet);
    tenant.modelAccess = 'suppressed';
    renderTenant(tenant, fleet);
    assert.doesNotMatch(readFileSync(path.join(dir, '.env'), 'utf8'), /ANTHROPIC_API_KEY|KIMI_API_KEY|MINIMAX_API_KEY/);
    assert.match(readFileSync(path.join(dir, '.model-credentials.env'), 'utf8'), /ANTHROPIC_API_KEY=anthropic-existing/);
    assert.match(readFileSync(path.join(dir, '.model-credentials.env'), 'utf8'), /MINIMAX_API_KEY=minimax-existing/);

    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    tenant.modelAccess = 'assigned';
    renderTenant(tenant, fleet);
    const restored = readFileSync(path.join(dir, '.env'), 'utf8');
    assert.match(restored, /ANTHROPIC_API_KEY=anthropic-existing/);
    assert.match(restored, /KIMI_API_KEY=kimi-existing/);
    assert.match(restored, /MINIMAX_API_KEY=minimax-existing/);
    const config = JSON.parse(readFileSync(path.join(dir, 'config', 'openclaw.json'), 'utf8'));
    assert.equal(config.agents.defaults.model.fallbacks.at(-1), 'minimax/MiniMax-M3');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
