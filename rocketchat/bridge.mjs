#!/usr/bin/env node
// Rocket.Chat <-> OpenClaw bridge.
//
// Runs on the datacenter box (where the openclaw-* containers live). Rocket.Chat
// posts an outgoing-webhook to /hook on every message in an openclaw channel;
// we run that channel's agent and post the reply back via the REST API.
//
// Channel "openclawN" maps to container "openclaw-openclawN". A user only ever
// reaches the container whose channel they're a member of — Rocket.Chat channel
// membership IS the access control.
import http from 'node:http';
import { execFile } from 'node:child_process';

const RC_URL = (process.env.RC_URL || 'http://127.0.0.1:3060').replace(/\/$/, '');
const BOT_USER = process.env.RC_BOT_USER || 'openclaw-bridge';
const BOT_PASS = process.env.RC_BOT_PASS || '';
const HOOK_TOKEN = process.env.WEBHOOK_TOKEN || '';
const PORT = Number(process.env.BRIDGE_PORT || 8090);
const CONTAINER_PREFIX = process.env.CONTAINER_PREFIX || 'openclaw-';
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 150000);

let auth = null; // { authToken, userId }

async function rc(path, { method = 'GET', body, useAuth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (useAuth && auth) {
    headers['X-Auth-Token'] = auth.authToken;
    headers['X-User-Id'] = auth.userId;
  }
  const res = await fetch(`${RC_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`RC ${path} ${res.status}: ${text.slice(0, 200)}`);
  return json;
}

async function login() {
  const j = await rc('/api/v1/login', {
    method: 'POST',
    useAuth: false,
    body: { user: BOT_USER, password: BOT_PASS },
  });
  auth = { authToken: j.data.authToken, userId: j.data.userId };
  console.log(`[bridge] logged in as ${BOT_USER} (${auth.userId})`);
}

async function postMessage(channelName, text) {
  try {
    await rc('/api/v1/chat.postMessage', {
      method: 'POST',
      body: { channel: `#${channelName}`, text },
    });
  } catch (e) {
    // token may have expired — re-login once and retry
    console.warn(`[bridge] post failed (${e.message}); re-login + retry`);
    await login();
    await rc('/api/v1/chat.postMessage', {
      method: 'POST',
      body: { channel: `#${channelName}`, text },
    });
  }
}

function runAgent(container, sessionKey, message) {
  return new Promise((resolve) => {
    execFile(
      'docker',
      ['exec', container, 'openclaw', 'agent', '--agent', 'main', '--session-key', sessionKey, '--message', message],
      { timeout: AGENT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = (stdout || '').trim();
        if (out) return resolve(out);
        console.warn(`[bridge] agent ${container} produced no output: ${(stderr || err?.message || '').slice(0, 200)}`);
        resolve('⚠️ Sorry — I hit an error handling that. Please try again in a moment.');
      },
    );
  });
}

async function handleMessage({ channel_name, user_name, text, bot }) {
  if (bot || user_name === BOT_USER) return; // never react to our own / bot posts
  if (!channel_name || !text) return;
  const container = `${CONTAINER_PREFIX}${channel_name}`;
  const sessionKey = `rc:${channel_name}:${user_name}`;
  console.log(`[bridge] ${channel_name} <- ${user_name}: ${text.slice(0, 80)}`);
  const reply = await runAgent(container, sessionKey, text);
  await postMessage(channel_name, reply);
  console.log(`[bridge] ${channel_name} -> replied ${reply.length} chars`);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/hook') {
    res.writeHead(404).end();
    return;
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
    if (HOOK_TOKEN && payload.token !== HOOK_TOKEN) {
      res.writeHead(401).end();
      return;
    }
    // ack immediately; process async so a slow agent can't time out the webhook
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    handleMessage(payload).catch((e) => console.error(`[bridge] handle error: ${e.message}`));
  });
});

// Start the webhook receiver immediately so it's reachable, and keep trying to
// log in in the background — Rocket.Chat may be unreachable until the Cloudflare
// tunnel is up. handleMessage() re-logs-in on demand if auth isn't ready yet.
server.listen(PORT, () => console.log(`[bridge] listening on :${PORT} -> ${RC_URL}`));

(async function loginLoop() {
  for (let attempt = 1; !auth; attempt++) {
    try {
      await login();
    } catch (e) {
      console.warn(`[bridge] login attempt ${attempt} failed (${e.message}); retrying in 15s`);
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
})();
