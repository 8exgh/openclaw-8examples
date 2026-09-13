import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { createTerminalBroker } from './broker.mjs';
import { terminalTransport } from './transport.mjs';

const root = process.env.MOC_ROOT;
if (!root) throw new Error('MOC_ROOT must point at the live managed-openclaw checkout');
const enabled = new Set((process.env.REMOTE_TERMINAL_TENANTS || '').split(',').filter(Boolean));
if (!enabled.size || [...enabled].some(tenant => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(tenant))) throw new Error('Explicitly enable the canary tenant');
const server = createTerminalBroker({
  serviceToken: process.env.REMOTE_CONNECT_SERVICE_TOKEN,
  publicOrigin: process.env.REMOTE_CONNECT_PUBLIC_ORIGIN || 'https://8examples.com',
  tenantCredential(tenant) {
    if (!enabled.has(tenant)) return;
    try {
      const record = JSON.parse(readFileSync(path.join(root, 'data/tenants.json'), 'utf8')).find(item => item.id === tenant);
      if (!record || record.offboardedAt || record.modelAccess === 'suppressed' || record.tier === 'desktop') return;
      return readFileSync(path.join(root, 'tenants', tenant, '.remote-terminal-key'), 'utf8').trim();
    } catch { return; }
  },
  createTransport: terminalTransport,
  onStatus(tenant, status) {
    const file = path.join(root, 'tenants', tenant, 'workspace/remote-terminal/status.json');
    writeFileSync(file + '.tmp', JSON.stringify(status) + '\n', { mode: 0o644 }); renameSync(file + '.tmp', file);
  },
});
const host = process.env.REMOTE_TERMINAL_HOST || '127.0.0.1';
if (host !== '127.0.0.1' && !/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(host)) throw new Error('Use loopback or a Tailscale address');
server.listen(Number(process.env.REMOTE_TERMINAL_PORT || 18882), host, () => console.log('Remote terminal broker ready.'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.shutdown(); setTimeout(() => process.exit(0), 2000).unref(); });
