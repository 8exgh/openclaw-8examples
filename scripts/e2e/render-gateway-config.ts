// Emits a minimal openclaw.json whose model provider block is exactly what
// renderTenant writes for a gateway tenant, pointed at the e2e mock.
// Usage: tsx render-gateway-config.ts <workdir> <mockBaseUrl> [--without-timeout]
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderTenant } from '../../src/provisioner/render.js';
import { tenantDir } from '../../src/store.js';
import type { Fleet, Tenant } from '../../src/types.js';

const [workdir, baseUrl, flag] = process.argv.slice(2);
const id = `e2etimeout${process.pid}`;
const fleet: Fleet = { releaseChannel: 'latest', image: 'test/image:latest', nextPort: 1 };
const tenant: Tenant = { id, name: id, contact: {}, channel: 'whatsapp', gatewayPort: 29995,
  tier: 'container', createdAt: new Date().toISOString(), modelAccess: 'assigned', capabilities: {}, nudgeLog: [],
  modelGatewayUrl: 'http://model-gateway:8790' };

const dir = tenantDir(id);
let rendered: any;
try {
  renderTenant(tenant, fleet);
  // Gateway-only cutover needs a real-looking key; the second render applies it.
  const envFile = path.join(dir, '.env');
  writeFileSync(envFile, readFileSync(envFile, 'utf8').replace(/^MODEL_GATEWAY_KEY=.*$/m,
    'MODEL_GATEWAY_KEY=mgw_e2e_000000000000000000000000000000000000000000000000'));
  renderTenant(tenant, fleet);
  rendered = JSON.parse(readFileSync(path.join(dir, 'config', 'openclaw.json'), 'utf8'));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const provider = { ...rendered.models.providers.gateway, baseUrl };
if (flag === '--without-timeout') delete provider.timeoutSeconds;
const config = {
  gateway: { mode: 'local', bind: 'loopback', port: 18789, auth: { mode: 'token', token: 'e2e-token' } },
  agents: { defaults: { model: { primary: rendered.agents.defaults.model.primary, fallbacks: [] } } },
  models: { mode: 'merge', providers: { gateway: provider } },
};
mkdirSync(path.join(workdir, 'state'), { recursive: true });
writeFileSync(path.join(workdir, 'state', 'openclaw.json'), JSON.stringify(config, null, 2));
console.log(JSON.stringify({ primary: config.agents.defaults.model.primary, timeoutSeconds: provider.timeoutSeconds ?? null }));
