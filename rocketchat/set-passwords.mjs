#!/usr/bin/env node
// Set a fresh random password for each openclaw1..openclawN Rocket.Chat user and
// print the list. Run against the Rocket.Chat admin API.
// Env: RC_URL, RC_ADMIN_USER, RC_ADMIN_PASS, COUNT (default 20)
import crypto from 'node:crypto';

const RC_URL = (process.env.RC_URL || 'http://localhost:3060').replace(/\/$/, '');
const ADMIN_USER = process.env.RC_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.RC_ADMIN_PASS || 'openclaw-admin';
const COUNT = Number(process.env.COUNT || 20);

// readable-ish: no ambiguous chars (0/O/1/l/I), 14 chars
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genPassword(len = 14) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

let auth = null;
async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) { headers['X-Auth-Token'] = auth.authToken; headers['X-User-Id'] = auth.userId; }
  const res = await fetch(`${RC_URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, j };
}

async function main() {
  const r = await api('/api/v1/login', { method: 'POST', body: { user: ADMIN_USER, password: ADMIN_PASS } });
  if (!r.ok) throw new Error(`admin login failed: ${JSON.stringify(r.j)}`);
  auth = { authToken: r.j.data.authToken, userId: r.j.data.userId };

  const results = [];
  for (let i = 1; i <= COUNT; i++) {
    const username = `openclaw${i}`;
    const info = await api(`/api/v1/users.info?username=${username}`);
    if (!info.ok || !info.j.user) { results.push([username, `(not found: ${JSON.stringify(info.j).slice(0, 80)})`]); continue; }
    const password = genPassword();
    const upd = await api('/api/v1/users.update', { method: 'POST', body: { userId: info.j.user._id, data: { password } } });
    results.push([username, upd.ok ? password : `(FAILED: ${JSON.stringify(upd.j).slice(0, 80)})`]);
  }

  console.log('\n===== OPENCLAW ROCKET.CHAT PASSWORDS =====');
  for (const [u, p] of results) console.log(`${u}\t${p}`);
  console.log('==========================================');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
