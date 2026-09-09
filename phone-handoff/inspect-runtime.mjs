// Read-only health probe. Emits counts only, never phone records, keys or peers.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const state = process.env.OPENCLAW_STATE_DIR || '/home/node/.openclaw';
const config = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH || path.join(state, 'openclaw.json'), 'utf8'));
const plugin = config.plugins?.entries?.['managed-phone-handoff'];
if (!plugin?.enabled) throw new Error('Phone handoff is not enabled');
const owner = plugin.config.owner;
const scope = createHash('sha256').update(JSON.stringify([process.env.PHONE_GATEWAY_URL, process.env.PHONE_GATEWAY_API_KEY, owner])).digest('hex');
const file = path.join(state, 'phone-handoff', scope, 'inbox.sqlite');
if (!existsSync(file)) throw new Error('Runtime inbox has not started');
const db = new DatabaseSync(file, { readOnly: true });
try {
  const lastSyncAt = db.prepare('SELECT value FROM metadata WHERE key=?').get('lastSyncAt')?.value;
  if (!(Date.now() - Date.parse(lastSyncAt) < 120000)) throw new Error('Runtime has not recently synchronized authenticated phone history');
  const groups = (table, field) => db.prepare(`SELECT json_extract(body, '$.${field}') status, count(*) count FROM ${table} GROUP BY status`).all();
  const health = await fetch('http://127.0.0.1:18789/healthz', { signal: AbortSignal.timeout(5000) });
  if (!health.ok) throw new Error('Gateway is not healthy');
  console.log(JSON.stringify({ healthy: true, channel: owner.channel, lastSyncAt, calls: groups('calls', 'status'), deliveriesAndCallbacks: groups('attempts', 'status') }));
} finally { db.close(); }
