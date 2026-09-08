import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { createBroker } from './broker.mjs';
import { browserTransport } from './transport.mjs';

const root = process.env.MOC_ROOT;
if (!root) throw new Error('MOC_ROOT must point at the live managed-openclaw checkout');
const server = createBroker({
  serviceToken: process.env.REMOTE_CONNECT_SERVICE_TOKEN,
  publicOrigin: process.env.REMOTE_CONNECT_PUBLIC_ORIGIN || 'https://8examples.com',
  tenantCredential(tenant) {
    try {
      const tenants = JSON.parse(readFileSync(path.join(root, 'data/tenants.json'), 'utf8'));
      const record = tenants.find((item) => item.id === tenant);
      if (!record || record.offboardedAt || record.modelAccess === 'suppressed' || record.tier === 'desktop') return undefined;
      return readFileSync(path.join(root, 'tenants', tenant, '.remote-connect-key'), 'utf8').trim();
    } catch { return undefined; }
  },
  createTransport: browserTransport,
  onFailure(event) { console.warn(JSON.stringify({ event: 'remote_browser_interrupted', ...event })); },
  onStatus(tenant, status) {
    const file = path.join(root, 'tenants', tenant, 'workspace/remote-connect/status.json');
    writeFileSync(file + '.tmp', JSON.stringify(status) + '\n', { mode: 0o644 });
    renameSync(file + '.tmp', file);
  },
});
// Set to the private tailnet address in production. Never bind 0.0.0.0.
const host = process.env.REMOTE_CONNECT_HOST || '127.0.0.1';
if (host !== '127.0.0.1' && !/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(host)) throw new Error('Bind the remote broker to loopback or a Tailscale address');
server.listen(Number(process.env.REMOTE_CONNECT_PORT || 18880), host, () => console.log(`Remote browser broker listening on ${host}:${server.address().port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
