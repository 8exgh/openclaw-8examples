// Public HTTPS smoke test. No customer secrets or chat delivery. Closes its shell.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile);
const container = 'openclaw-openclaw1';
const helper = async action => JSON.parse((await exec('docker', ['exec', '--user', 'node', '--workdir', '/home/node/.openclaw/workspace', container, 'node', 'remote-terminal/session.mjs', action], { timeout: 35000, maxBuffer: 32768 })).stdout);
let created = false;
try {
  // Fail rather than replace a human's attached session during a repeated check.
  const prior = await helper('status').catch(() => undefined);
  if (prior?.status === 'connected' && Date.parse(prior.expiresAt) > Date.now()) throw new Error('Canary owner already has an active terminal; leave it alone.');
  let session;
  if (process.env.REMOTE_TERMINAL_VERIFY_AGENT === '1') {
    const { stdout } = await exec('docker', ['exec', container, 'openclaw', 'agent', '--agent', 'main',
      '--session-key', `agent:main:telegram:direct:terminal-check-${randomUUID()}`, '--message', 'Please open a remote terminal', '--timeout', '90', '--json'], { timeout: 120000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout);
    const reply = (result.result?.payloads || result.payloads || []).map(p => p.text || '').join('\n');
    const url = reply.match(/https:\/\/8examples\.com\/remote-terminal\/[0-9a-f-]{36}/)?.[0];
    const code = reply.match(/\b\d{6}\b/)?.[0];
    assert(url && code, 'Canary must actually offer the terminal link and code');
    const status = await helper('status'); assert.equal(new URL(url).pathname.split('/').at(-1), status.id);
    session = { ...status, url, code };
    console.log('PASS: the running canary offers a real terminal handoff through its normal private-chat pipeline.');
  } else session = await helper('create');
  created = true;
  const origin = 'https://8examples.com', api = `${origin}/api/remote-terminal/${session.id}`;
  const page = await fetch(session.url); assert.equal(page.status, 200); assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await fetch(api + '/output')).status, 401);
  const redeemed = await fetch(api + '/unlock', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: session.code }) });
  assert.equal(redeemed.status, 200);
  const cookie = redeemed.headers.get('set-cookie'); assert.match(cookie, /HttpOnly/i); assert.match(cookie, /Secure/i); assert.match(cookie, /SameSite=Strict/i);
  assert.equal((await redeemed.json()).viewerToken, undefined);
  const headers = { Origin: origin, Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' };
  assert.equal((await fetch(api + '/input', { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: '{}' })).status, 403);
  const marker = 'TERMINAL_OK_' + randomUUID().replaceAll('-', '');
  const command = `printf '${marker}:%s:%s\\n' "$(id -un)" "$(test -t 0 && echo tty)"\r`;
  const sent = await fetch(api + '/input', { method: 'POST', headers, body: JSON.stringify({ sequence: 1, data: Buffer.from(command).toString('base64') }) });
  assert.equal(sent.status, 200);
  let verified = false;
  for (let n = 0; n < 30; n++) {
    const response = await fetch(api + '/output', { headers }); assert.equal(response.status, 200);
    const output = (await response.json()).chunks.map(c => Buffer.from(c.data, 'base64').toString()).join('');
    if (output.includes(`${marker}:node:tty`)) { verified = true; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert(verified, 'Real PTY input/output through public HTTPS');
  if ((await (await fetch(api + '/state', { headers })).json()).adminAvailable) {
    const switched = await fetch(api + '/shell', { method: 'POST', headers, body: JSON.stringify({ mode: 'root' }) });
    assert.equal(switched.status, 200); assert.equal((await switched.json()).mode, 'root');
    const adminMarker = 'ADMIN_OK_' + randomUUID().replaceAll('-', '');
    const command = `test ! -S /var/run/docker.sock && t=$(mktemp) && chown node "$t" && rm "$t" && printf '${adminMarker}:%s:%s\\n' "$(id -un)" "$(runuser -u node -- id -un)"\r`;
    assert.equal((await fetch(api + '/input', { method: 'POST', headers, body: JSON.stringify({ sequence: 1, data: Buffer.from(command).toString('base64') }) })).status, 200);
    let adminVerified = false;
    for (let n = 0; n < 30; n++) {
      const output = (await (await fetch(api + '/output', { headers })).json()).chunks.map(c => Buffer.from(c.data, 'base64').toString()).join('');
      if (output.includes(`${adminMarker}:root:node`)) { adminVerified = true; break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert(adminVerified, 'Owner has working root permissions inside their own container');
    console.log('PASS: public admin shell has real root permissions, can switch to the Claw user, and has no host Docker socket.');
  }
  const ended = await fetch(api + '/complete', { method: 'POST', headers, body: '{}' }); assert.equal(ended.status, 200);
  assert.equal((await helper('status')).status, 'completed');
  console.log('PASS: public terminal page, one-time code, protected cookie, CSRF, real node-user PTY input/output, and terminal cleanup.');
} finally { if (created) await helper('revoke'); }
