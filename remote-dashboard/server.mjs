import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { createBroker } from '../remote-connect/broker.mjs';
import { dashboardProxyTransport } from './proxy-transport.mjs';
import { attachDashboardProxy } from './proxy-broker.mjs';

const root = process.env.MOC_ROOT;
const enabled = new Set((process.env.REMOTE_DASHBOARD_TENANTS || '').split(',').filter(Boolean));
if (!root || !enabled.size || [...enabled].some(t => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(t))) throw new Error('Set MOC_ROOT and explicitly enabled dashboard tenants');
const server = attachDashboardProxy(createBroker({
  serviceToken: process.env.REMOTE_CONNECT_SERVICE_TOKEN,
  publicOrigin: process.env.REMOTE_CONNECT_PUBLIC_ORIGIN || 'https://8examples.com',
  publicPath: 'remote-dashboard', recreateTransport: false,
  tenantCredential(tenant) {
    if (!enabled.has(tenant)) return;
    try {
      const record = JSON.parse(readFileSync(path.join(root, 'data/tenants.json'), 'utf8')).find(t => t.id === tenant);
      if (!record || record.offboardedAt || record.modelAccess === 'suppressed' || record.tier === 'desktop') return;
      return readFileSync(path.join(root, 'tenants', tenant, '.remote-dashboard-key'), 'utf8').trim();
    } catch { return; }
  },
  createTransport: dashboardProxyTransport,
  onStatus(tenant, status) {
    // Authoritative status is not in the owner-writable workspace. Helpers
    // query it through the authenticated broker when they need current state.
    const file = path.join(root, 'tenants', tenant, '.remote-dashboard-status.json');
    writeFileSync(file + '.tmp', JSON.stringify(status) + '\n', { mode: 0o600 });
    renameSync(file + '.tmp', file);
  },
}));
const host = process.env.REMOTE_DASHBOARD_HOST || '127.0.0.1';
if (host !== '127.0.0.1' && !/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(host)) throw new Error('Use loopback or Tailscale');
server.listen(Number(process.env.REMOTE_DASHBOARD_PORT || 18884), host, () => console.log('Remote dashboard broker ready.'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.shutdown(); setTimeout(() => process.exit(0), 2000).unref(); });
