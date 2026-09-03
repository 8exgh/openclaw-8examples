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

const TEST_KEY = 'mgw_test_000000000000000000000000000000000000000000000000';

function makeTenant(id: string): Tenant {
  return { id, name: id, contact: {}, channel: 'whatsapp', gatewayPort: 29995,
    tier: 'container', createdAt: new Date().toISOString(), modelAccess: 'assigned', capabilities: {}, nudgeLog: [] };
}

function readConfig(dir: string): any {
  return JSON.parse(readFileSync(path.join(dir, 'config', 'openclaw.json'), 'utf8'));
}

test('model-gateway cutover waits for a real key, then goes gateway-only', () => {
  const id = `test-mgw-${Date.now()}`;
  const tenant = makeTenant(id);
  const dir = path.join(process.cwd(), 'tenants', id);
  const composeFile = path.join(dir, 'docker-compose.yml');
  try {
    tenant.modelGatewayUrl = 'http://model-gateway:8790';

    // Flag set but no minted key yet: joins the network, reports the missing
    // key, and keeps the direct provider wiring.
    const missing = renderTenant(tenant, fleet);
    assert.ok(missing.includes('MODEL_GATEWAY_KEY'), 'key must be reported as placeholder');
    let config = readConfig(dir);
    assert.equal(config.agents.defaults.model.primary, 'anthropic/claude-opus-4-8');
    assert.equal(config.models.providers.gateway, undefined);
    assert.ok(config.models.providers.kimi, 'direct providers stay until cutover');
    const compose = readFileSync(composeFile, 'utf8');
    assert.match(compose, /name: openclaw-model-gateway/);
    assert.match(compose, /- model-gateway/);

    // Operator installs the minted key: next apply cuts over to gateway-ONLY.
    const envFile = path.join(dir, '.env');
    writeFileSync(envFile, readFileSync(envFile, 'utf8').replace(
      /^MODEL_GATEWAY_KEY=.*$/m,
      `MODEL_GATEWAY_KEY=${TEST_KEY}`,
    ));
    renderTenant(tenant, fleet);
    config = readConfig(dir);
    assert.equal(config.agents.defaults.model.primary, 'gateway/claude-opus-4-8');
    assert.deepEqual(config.agents.defaults.model.fallbacks, ['gateway/claude-sonnet-5']);
    assert.equal(config.models.providers.gateway.baseUrl, 'http://model-gateway:8790');
    assert.equal(config.models.providers.gateway.apiKey, '${MODEL_GATEWAY_KEY}');
    assert.equal(config.models.providers.kimi, undefined, 'no direct providers on gateway tenants');
    assert.equal(config.models.providers.minimax, undefined);
    // Direct model credentials leave the claw's env (placeholders just drop;
    // real values land in escrow — see the suppressed test).
    const env = readFileSync(envFile, 'utf8');
    assert.ok(!env.includes('KIMI_API_KEY='), 'direct creds must leave the claw env');
    assert.ok(!env.includes('ANTHROPIC_API_KEY='));
    assert.match(env, new RegExp(`^MODEL_GATEWAY_KEY=${TEST_KEY}$`, 'm'));

    // Rollback: clearing the flag restores direct wiring, creds, and leaves
    // the shared network (no external network needed to compose up).
    delete tenant.modelGatewayUrl;
    renderTenant(tenant, fleet);
    config = readConfig(dir);
    assert.equal(config.agents.defaults.model.primary, 'anthropic/claude-opus-4-8');
    assert.ok(config.agents.defaults.model.fallbacks.includes('openai/gpt-5.6-sol'));
    assert.equal(config.models.providers.gateway, undefined);
    assert.ok(config.models.providers.kimi);
    assert.match(readFileSync(envFile, 'utf8'), /^KIMI_API_KEY=/m);
    assert.ok(!readFileSync(composeFile, 'utf8').includes('openclaw-model-gateway'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('suppressed inventory renders gateway-only shape with every credential escrowed', () => {
  const id = `test-mgw-sup-${Date.now()}`;
  const tenant = makeTenant(id);
  tenant.modelAccess = 'suppressed';
  tenant.modelGatewayUrl = 'http://model-gateway:8790';
  const dir = path.join(process.cwd(), 'tenants', id);
  const envFile = path.join(dir, '.env');
  const escrowFile = path.join(dir, '.model-credentials.env');
  try {
    // Operator pre-mints the key into .env, then renders while suppressed.
    renderTenant(tenant, fleet);
    writeFileSync(envFile, readFileSync(envFile, 'utf8') + `MODEL_GATEWAY_KEY=${TEST_KEY}\n`);
    renderTenant(tenant, fleet);

    // Config shape: the ONLY model path is the gateway, and there is no key
    // in the runtime env — the claw cannot consume even if started by hand.
    const config = readConfig(dir);
    assert.equal(config.agents.defaults.model.primary, 'gateway/claude-opus-4-8');
    assert.equal(config.models.providers.kimi, undefined);
    assert.equal(config.models.providers.gateway.apiKey, '${MODEL_GATEWAY_KEY}');
    const env = readFileSync(envFile, 'utf8');
    assert.ok(!env.includes('MODEL_GATEWAY_KEY='), 'suppressed claws must not hold the key');
    assert.ok(!env.includes('KIMI_API_KEY='));
    assert.match(readFileSync(escrowFile, 'utf8'), new RegExp(`^MODEL_GATEWAY_KEY=${TEST_KEY}$`, 'm'));

    // Assignment restores the key from escrow and stays gateway-only.
    tenant.modelAccess = 'assigned';
    renderTenant(tenant, fleet);
    assert.match(readFileSync(envFile, 'utf8'), new RegExp(`^MODEL_GATEWAY_KEY=${TEST_KEY}$`, 'm'));
    const assigned = readConfig(dir);
    assert.equal(assigned.agents.defaults.model.primary, 'gateway/claude-opus-4-8');
    assert.equal(assigned.models.providers.kimi, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
