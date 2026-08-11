#!/usr/bin/env node
// Provision Rocket.Chat for the openclaw fleet:
//   - a bridge bot account (the thing that posts replies)
//   - N users openclaw1..openclawN (password = username by default)
//   - N private channels openclaw1..openclawN, each with only its user + the bot
//   - one outgoing webhook that POSTs every openclaw-channel message to the bridge
//
// Channel membership IS the access control: user openclawK only sees #openclawK.
// Issue someone a second openclaw by adding their account to that channel too
// (groups.invite), no other change needed.
//
// Env: RC_URL, RC_ADMIN_USER, RC_ADMIN_PASS, BRIDGE_HOOK_URL, WEBHOOK_TOKEN,
//      RC_BOT_USER, RC_BOT_PASS, COUNT (default 20)
const RC_URL = (process.env.RC_URL || 'http://localhost:3060').replace(/\/$/, '');
const ADMIN_USER = process.env.RC_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.RC_ADMIN_PASS || 'openclaw-admin';
const BOT_USER = process.env.RC_BOT_USER || 'openclaw-bridge';
const BOT_PASS = process.env.RC_BOT_PASS || 'openclaw-bridge-pass';
const HOOK_URL = process.env.BRIDGE_HOOK_URL || 'http://127.0.0.1:8090/hook';
const HOOK_TOKEN = process.env.WEBHOOK_TOKEN || 'changeme-hook-token';
const COUNT = Number(process.env.COUNT || 20);

let auth = null;

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) { headers['X-Auth-Token'] = auth.authToken; headers['X-User-Id'] = auth.userId; }
  const res = await fetch(`${RC_URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, j };
}

// tolerate "already exists" so the script is re-runnable
async function idempotent(label, fn, existsRe = /already|exists|in use|duplicate/i) {
  const r = await fn();
  if (r.ok) { console.log(`  ok: ${label}`); return r; }
  const msg = r.j?.error || r.j?.message || JSON.stringify(r.j);
  if (existsRe.test(msg)) { console.log(`  skip (exists): ${label}`); return r; }
  console.warn(`  FAIL: ${label} -> ${r.status} ${msg}`);
  return r;
}

async function login() {
  const r = await api('/api/v1/login', { method: 'POST', body: { user: ADMIN_USER, password: ADMIN_PASS } });
  if (!r.ok) throw new Error(`admin login failed: ${JSON.stringify(r.j)}`);
  auth = { authToken: r.j.data.authToken, userId: r.j.data.userId };
  console.log(`logged in as ${ADMIN_USER}`);
}

async function main() {
  await login();

  // bridge bot (role 'bot' so it doesn't count as a seat / show in directory prominently)
  await idempotent(`bot ${BOT_USER}`, () => api('/api/v1/users.create', {
    method: 'POST',
    body: { username: BOT_USER, name: 'OpenClaw', email: `${BOT_USER}@fusenv.com`, password: BOT_PASS, roles: ['bot'], requirePasswordChange: false, verified: true },
  }));

  for (let i = 1; i <= COUNT; i++) {
    const name = `openclaw${i}`;
    await idempotent(`user ${name}`, () => api('/api/v1/users.create', {
      method: 'POST',
      body: { username: name, name, email: `${name}@fusenv.com`, password: name, roles: ['user'], requirePasswordChange: false, verified: true, joinDefaultChannels: false },
    }));
    // private group with the user + bot as members
    await idempotent(`group ${name}`, () => api('/api/v1/groups.create', {
      method: 'POST',
      body: { name, members: [name, BOT_USER] },
    }));
  }

  // one outgoing webhook covering all openclaw channels — create OR update so
  // re-running with a higher COUNT extends coverage to the new channels.
  const channels = Array.from({ length: COUNT }, (_, k) => `#openclaw${k + 1}`).join(',');
  const body = {
    type: 'webhook-outgoing',
    name: 'openclaw-bridge',
    enabled: true,
    username: BOT_USER,
    event: 'sendMessage',
    channel: channels,
    urls: [HOOK_URL],
    token: HOOK_TOKEN,
    scriptEnabled: false,
    impersonateUser: false,
  };
  const list = await api('/api/v1/integrations.list?count=0');
  const existing = list.j?.integrations?.find((x) => x.name === 'openclaw-bridge' && x.type === 'webhook-outgoing');
  if (existing) {
    await idempotent('update webhook (all channels)', () =>
      api('/api/v1/integrations.update', { method: 'POST', body: { integrationId: existing._id, ...body } }));
  } else {
    await idempotent('create webhook', () => api('/api/v1/integrations.create', { method: 'POST', body }));
  }

  console.log(`\nDone. ${COUNT} users/channels + bot + webhook -> ${HOOK_URL}`);
  console.log('Users: openclaw1..openclaw' + COUNT + ' (password = username). Bot: ' + BOT_USER);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
