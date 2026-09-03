import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { renderTenant } from '../src/provisioner/render.js';
import type { Fleet, Tenant } from '../src/types.js';

const fleet: Fleet = {
  releaseChannel: 'latest',
  image: 'test/image:latest',
  nextPort: 1,
};

function makeTenant(id: string): Tenant {
  return { id, name: id, contact: {}, channel: 'whatsapp', gatewayPort: 29995,
    tier: 'container', createdAt: new Date().toISOString(), modelAccess: 'assigned', capabilities: {}, nudgeLog: [] };
}

test('model-gateway cutover waits for a real key, then rewires primary model', () => {
  const id = `test-mgw-${Date.now()}`;
  const tenant = makeTenant(id);
  const dir = path.join(process.cwd(), 'tenants', id);
  const configFile = path.join(dir, 'config', 'openclaw.json');
  const composeFile = path.join(dir, 'docker-compose.yml');
  try {
    tenant.modelGatewayUrl = 'http://model-gateway:8790';

    // Flag set but no minted key yet: joins the network, reports the missing
    // key, and keeps the direct provider wiring.
    const missing = renderTenant(tenant, fleet);
    assert.ok(missing.includes('MODEL_GATEWAY_KEY'), 'key must be reported as placeholder');
    let config = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(config.agents.defaults.model.primary, 'anthropic/claude-opus-4-8');
    assert.equal(config.models.providers.gateway, undefined);
    const compose = readFileSync(composeFile, 'utf8');
    assert.match(compose, /name: openclaw-model-gateway/);
    assert.match(compose, /- model-gateway/);

    // Operator installs the minted key: next apply cuts over.
    const envFile = path.join(dir, '.env');
    const env = readFileSync(envFile, 'utf8').replace(
      /^MODEL_GATEWAY_KEY=.*$/m,
      'MODEL_GATEWAY_KEY=mgw_test_000000000000000000000000000000000000000000000000',
    );
    writeFileSync(envFile, env);
    renderTenant(tenant, fleet);
    config = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(config.agents.defaults.model.primary, 'gateway/claude-opus-4-8');
    assert.equal(config.models.providers.gateway.baseUrl, 'http://model-gateway:8790');
    assert.equal(config.models.providers.gateway.apiKey, '${MODEL_GATEWAY_KEY}');
    assert.ok(
      !config.agents.defaults.model.fallbacks.includes('openai/gpt-5.6-sol'),
      'gateway tenants drop the dead direct-openai fallback',
    );
    assert.ok(config.agents.defaults.model.fallbacks.includes('kimi/k3'));

    // Rollback: clearing the flag restores direct wiring and leaves the
    // shared network (no external network needed to compose up).
    delete tenant.modelGatewayUrl;
    renderTenant(tenant, fleet);
    config = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(config.agents.defaults.model.primary, 'anthropic/claude-opus-4-8');
    assert.equal(config.models.providers.gateway, undefined);
    assert.ok(!readFileSync(composeFile, 'utf8').includes('openclaw-model-gateway'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
