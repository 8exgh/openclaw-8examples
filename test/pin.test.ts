import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { renderTenant } from '../src/provisioner/render.js';
import type { Fleet, Tenant } from '../src/types.js';

const fleet: Fleet = {
  releaseChannel: 'latest',
  image: 'test/image:latest',
  pinnedImageRef: 'test/image@sha256:fleetpin',
  nextPort: 1,
};

test('a tenant pin overrides the fleet release until cleared', () => {
  const id = `test-pin-${Date.now()}`;
  const tenant: Tenant = { id, name: id, contact: {}, channel: 'whatsapp', gatewayPort: 29994,
    tier: 'container', createdAt: new Date().toISOString(), modelAccess: 'assigned', capabilities: {}, nudgeLog: [] };
  const compose = path.join(process.cwd(), 'tenants', id, 'docker-compose.yml');
  try {
    tenant.pinnedImageRef = 'test/image@sha256:canarypin';
    renderTenant(tenant, fleet);
    assert.match(readFileSync(compose, 'utf8'), /image: "test\/image@sha256:canarypin"/);

    delete tenant.pinnedImageRef;
    renderTenant(tenant, fleet);
    assert.match(readFileSync(compose, 'utf8'), /image: "test\/image@sha256:fleetpin"/);
  } finally {
    rmSync(path.join(process.cwd(), 'tenants', id), { recursive: true, force: true });
  }
});
