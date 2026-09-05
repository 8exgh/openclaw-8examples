import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from './store.mjs';
import { mobileIdentity, vault } from './security.mjs';
import { createApp } from './app.mjs';
import { createAPNs } from './apns.mjs';
import { deliverPushes, dockerRunner, runOne } from './worker.mjs';

process.umask(0o077);
const credentials = vault(process.env.SESSION_ENCRYPTION_KEY);
const publishers = JSON.parse(readFileSync(process.env.PUBLISHERS_FILE || './config.local.json', 'utf8'));
if (!publishers || Array.isArray(publishers) || !Object.entries(publishers).every(([id, key]) =>
  /^[a-z0-9-]{1,64}$/.test(id) && /^gws_[a-f0-9]{64}$/.test(key))) throw new Error('Invalid publisher configuration');
const dbFile = resolve(process.env.DB_FILE || './data/glasses.sqlite');
mkdirSync(dirname(dbFile), { recursive: true, mode: 0o700 });
const store = new Store(dbFile);
const authenticate = mobileIdentity(process.env.IDENTITY_URL || 'https://8examples.com');
const push = process.env.APNS_KEY_FILE ? createAPNs({ teamId: process.env.APNS_TEAM_ID, keyId: process.env.APNS_KEY_ID,
  privateKey: readFileSync(process.env.APNS_KEY_FILE, 'utf8'), topic: process.env.APNS_TOPIC,
  environment: process.env.APNS_ENVIRONMENT }) : null;
const app = createApp({ store, authenticate, vault: credentials, publishers, pushEnabled: !!push });
const port = Number(process.env.PORT || 8795);
await app.listen({ host: process.env.HOST || '127.0.0.1', port });
store.recoverInterrupted();
console.log(`Glasses relay listening on port ${port}; push ${push ? 'configured' : 'not configured'}`);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });
const context = { store, authenticate, vault: credentials, runAgent: dockerRunner() };
// One task at a time. This process is the sole worker for this database.
const jobs = (async () => {
  while (!stopping) {
    try { if (await runOne(context)) continue; }
    catch { console.error('Task worker failed; inspect task status before restarting'); stopping = true; }
    await delay(1000);
  }
})();
const notifications = (async () => {
  while (!stopping) {
    if (push) {
      try { await deliverPushes({ ...context, push }); } catch { console.error('Notification delivery will retry'); }
    }
    await delay(3000);
  }
})();
await Promise.all([jobs, notifications]);
await app.close();
store.close();
