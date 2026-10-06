import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDashboardClient } from './dashboard-client.mjs';

const config = JSON.parse(readFileSync('/home/node/.openclaw/openclaw.json', 'utf8'));
const resolve = value => {
  if (value?.source === 'env') return process.env[value.id];
  if (typeof value !== 'string') return undefined;
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => process.env[name] || '');
};
const token = resolve(config.gateway?.auth?.token) || process.env.OPENCLAW_GATEWAY_TOKEN;
if (!token || config.gateway?.controlUi?.enabled === false) throw new Error('Dashboard is not available');
const profile = config.browser?.profiles?.openclaw;
const cdp = new URL(profile?.cdpUrl || `http://127.0.0.1:${profile?.cdpPort || 18800}`);
if (!['localhost', '127.0.0.1', '[::1]'].includes(cdp.hostname) || cdp.protocol !== 'http:') throw new Error('Local browser required');
try {
  if (!(await fetch(new URL('/json/version', cdp), { signal: AbortSignal.timeout(1500) })).ok) throw 0;
} catch {
  await promisify(execFile)(process.execPath, ['/app/openclaw.mjs', 'browser', '--browser-profile', 'openclaw', 'start'], { timeout: 15000, maxBuffer: 16384 });
}
const gateway = new URL(`http://127.0.0.1:${config.gateway?.port || 18789}`);
gateway.pathname = (config.gateway?.controlUi?.basePath || '').replace(/\/$/, '') + '/';
let client;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let queue = Promise.resolve();
createInterface({ input: process.stdin }).on('line', line => {
  queue = queue.then(async () => {
    let request;
    try {
      request = JSON.parse(line);
      client ??= await createDashboardClient(cdp, gateway, token);
      emit({ id: request.id, result: await client.handle(request.action, request.data || {}) });
    } catch (error) {
      client?.close();
      emit({ id: request?.id, error: 'Dashboard connection ended', code: /^dashboard_[a-z_]+$/.test(error.code || '') ? error.code : 'dashboard_unavailable', retryable: false });
    }
  });
}).on('close', () => { client?.close(); process.exit(0); });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { client?.close(); process.exit(0); });
setTimeout(() => { client?.close(); process.exit(0); }, 16 * 60_000).unref();
