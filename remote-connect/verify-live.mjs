// Run on the fleet host after the website deploy. Exercises the public HTTPS
// route using the real helper INSIDE the canary Claw, then closes its test tab.
// Only opens example.com; no credentials, chat messages, or customer sites.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile);
const tenant = process.argv[2] || 'openclaw1';
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(tenant)) throw new Error('Invalid canary tenant');
const container = `openclaw-${tenant}`;
const cli = async (...args) => (await exec('docker', ['exec', container, 'openclaw', 'browser', '--browser-profile', 'openclaw', ...args], { timeout: 60000, maxBuffer: 1024 * 1024 })).stdout;
const helper = async (action, targetId) => JSON.parse((await exec('docker', ['exec', '-w', '/home/node/.openclaw/workspace', container, 'node', 'remote-connect/session.mjs', action, ...(targetId ? [targetId] : [])], { timeout: 30000 })).stdout);
let tab;
let created = false;
try {
  await cli('start');
  const opened = JSON.parse(await cli('open', 'https://example.com', '--json'));
  tab = opened.targetId || opened.id;
  assert.ok(tab, 'OpenClaw returned the test tab');
  let session;
  if (process.env.REMOTE_CONNECT_VERIFY_AGENT === '1') {
    // No --deliver: this exercises contextual agent behavior without posting
    // any message to a customer's chat channel or entering real credentials.
    const existingSession = process.env.REMOTE_CONNECT_VERIFY_SESSION;
    const request = existingSession
      ? "The browser link you gave me won't open on my phone. Can you get me connected so I can sign in myself?"
      : 'I need to sign in, but I want to enter my username and password myself directly in your browser instead of sending them in chat. Please set up a remote browser connection and give me the link and code.';
    const message = `${request} For this setup check use the existing managed openclaw browser tab ${tab} on https://example.com. Do not enter any credentials, navigate away, or send any messages to other people. End your turn once you have given me the handoff.`;
    let stdout;
    try {
      ({ stdout } = await exec('docker', ['exec', container, 'openclaw', 'agent', '--agent', 'main', '--session-key', existingSession || `remote-login-check:${randomUUID()}`, '--message', message, '--timeout', '300', '--json'], { timeout: 330000, maxBuffer: 2 * 1024 * 1024 }));
    } catch (error) {
      let status = 'failed';
      try { status = JSON.parse(error.stdout).status || status; } catch {}
      // CLI errors carry the entire prompt/tool report in stdout. Keep it out
      // of Actions logs; the status is enough to distinguish a model timeout.
      throw new Error(`Canary agent ${status}; the browser-only public check can be run separately.`);
    }
    const result = JSON.parse(stdout);
    const text = (result.result?.payloads || result.payloads || []).map((item) => item.text || '').join('\n');
    assert.ok(!/https?:\/\/(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])(?=[:/\s]|$)/i.test(text), 'The Claw must not offer an internal portal URL');
    const url = text.match(/https:\/\/8examples\.com\/remote-connect\/[0-9a-f-]{36}/)?.[0];
    const code = text.match(/\b\d{6}\b/)?.[0];
    assert.ok(url && code, 'The Claw must contextually create and return a remote URL and six-digit code');
    const status = await helper('status');
    assert.equal(status.id, new URL(url).pathname.split('/').pop(), 'The offered URL must be the session the Claw actually created');
    session = { ...status, url, code };
    console.log(existingSession
      ? 'PASS: the existing conversation recovered from its broken handoff and created a real public link and code.'
      : 'PASS: the Claw contextually offered and actually created the remote login using its installed instructions.');
  } else session = await helper('create', tab);
  created = true;
  const origin = new URL(session.url).origin;
  assert.equal(origin, 'https://8examples.com');
  const page = await fetch(session.url, { signal: AbortSignal.timeout(20000) });
  assert.equal(page.status, 200, 'Public viewer page');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const base = `${origin}/api/remote-connect/${session.id}`;
  assert.equal((await fetch(base + '/frame')).status, 401, 'Frames require authorization');
  const unlocked = await fetch(base + '/unlock', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: session.code }), signal: AbortSignal.timeout(20000) });
  assert.equal(unlocked.status, 200, 'Public code redemption');
  const setCookie = unlocked.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=strict/i);
  assert.equal((await unlocked.json()).viewerToken, undefined, 'Viewer secret stays out of JavaScript');
  const headers = { Origin: origin, Cookie: setCookie.split(';')[0], 'Content-Type': 'application/json' };
  const frame = await fetch(base + '/frame', { headers, signal: AbortSignal.timeout(20000) });
  assert.equal(frame.status, 200, 'Live graphical browser frame over public HTTPS');
  const pixels = await frame.json();
  assert.ok(pixels.width > 0 && pixels.height > 0);
  assert.equal(Buffer.from(pixels.image, 'base64').readUInt16BE(0), 0xffd8, 'Real JPEG pixels');
  const done = await fetch(base + '/complete', { method: 'POST', headers, body: '{}' });
  assert.equal(done.status, 200);
  assert.equal((await helper('status')).status, 'completed', 'Claw sees returned control');
  assert.equal((await fetch(base + '/frame', { headers })).status, 410, 'Closed connection rejects previous viewer cookie');
  console.log(`PASS ${tenant}: in-container helper → public HTTPS page/code → private broker → actual browser pixels → Done → Claw status. No login credentials used.`);
} finally {
  if (created) await helper('revoke').catch(() => {});
  if (tab) await cli('close', tab).catch(() => {});
}
