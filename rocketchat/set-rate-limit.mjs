#!/usr/bin/env node
// Raise (or restore) Rocket.Chat's REST API rate limiter defaults. The limiter
// allows API_Default_Rate_Limiter_Calls requests per API_Default_Rate_Limiter_Time
// milliseconds per endpoint per client IP, and the stock default (10 per minute)
// is far too low for server-side integrations: the 8examples squeeze-page demo
// chat polled groups.history from one IP and tripped it for every visitor.
// Rocket.Chat rebuilds its limiter rules when these settings change; no restart.
// Env: RC_URL, RC_ADMIN_USER, RC_ADMIN_PASS, CALLS (default 600), TIME_MS (default 60000)

const RC_URL = (process.env.RC_URL || 'http://localhost:3060').replace(/\/$/, '');
const ADMIN_USER = process.env.RC_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.RC_ADMIN_PASS || 'openclaw-admin';
const CALLS = Number(process.env.CALLS || 600);
const TIME_MS = Number(process.env.TIME_MS || 60000);

if (!Number.isInteger(CALLS) || CALLS < 1) throw new Error(`CALLS must be a positive integer, got ${process.env.CALLS}`);
if (!Number.isInteger(TIME_MS) || TIME_MS < 1000) throw new Error(`TIME_MS must be >= 1000, got ${process.env.TIME_MS}`);

let auth = null;
async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) { headers['X-Auth-Token'] = auth.authToken; headers['X-User-Id'] = auth.userId; }
  const res = await fetch(`${RC_URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, j };
}

async function readSetting(id) {
  const r = await api(`/api/v1/settings/${id}`);
  if (!r.ok) throw new Error(`could not read ${id}: ${JSON.stringify(r.j).slice(0, 200)}`);
  return r.j.value;
}

async function writeSetting(id, value) {
  const r = await api(`/api/v1/settings/${id}`, { method: 'POST', body: { value } });
  if (!r.ok) throw new Error(`could not set ${id}: ${JSON.stringify(r.j).slice(0, 200)}`);
}

async function main() {
  const r = await api('/api/v1/login', { method: 'POST', body: { user: ADMIN_USER, password: ADMIN_PASS } });
  if (!r.ok) throw new Error(`admin login failed: ${JSON.stringify(r.j)}`);
  auth = { authToken: r.j.data.authToken, userId: r.j.data.userId };

  const enabled = await readSetting('API_Enable_Rate_Limiter');
  const before = { calls: await readSetting('API_Default_Rate_Limiter_Calls'), timeMs: await readSetting('API_Default_Rate_Limiter_Time') };
  console.log(`rate limiter enabled: ${enabled}`);
  console.log(`before: ${before.calls} calls per ${before.timeMs} ms per endpoint per IP`);

  await writeSetting('API_Default_Rate_Limiter_Calls', CALLS);
  await writeSetting('API_Default_Rate_Limiter_Time', TIME_MS);

  const after = { calls: await readSetting('API_Default_Rate_Limiter_Calls'), timeMs: await readSetting('API_Default_Rate_Limiter_Time') };
  console.log(`after:  ${after.calls} calls per ${after.timeMs} ms per endpoint per IP`);
  if (after.calls !== CALLS || after.timeMs !== TIME_MS) throw new Error('settings did not persist as requested');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
