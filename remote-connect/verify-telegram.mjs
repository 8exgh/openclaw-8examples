// Native Telegram polling + outbound delivery against a loopback-only fake Bot
// API. No real Telegram tokens, recipients, model credentials, or browser data.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const dir = mkdtempSync(path.join(tmpdir(), 'remote-telegram-'));
const modelRequests = [], delivered = [], updates = [];
let gateway, startup = '';
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const json = result => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); };
  if (req.url === '/json/list') return json([{ id: 'AAAABBBBCCCCDDDDEEEEFFFF00001111', type: 'page', url: 'https://www.linkedin.com/login' }]);
  if (req.url.startsWith('/bot')) {
    const method = req.url.split('/').pop();
    if (method === 'getMe') return json({ ok: true, result: { id: 123456, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' } });
    if (method === 'getWebhookInfo') return json({ ok: true, result: { url: '', pending_update_count: 0 } });
    if (method === 'getUpdates') { await new Promise(resolve => setTimeout(resolve, 100)); return json({ ok: true, result: updates.splice(0) }); }
    if (method === 'sendMessage' || method === 'editMessageText') {
      let body; try { body = JSON.parse(raw); } catch { body = Object.fromEntries(new URLSearchParams(raw)); }
      delivered.push(body.text || '');
      return json({ ok: true, result: { message_id: 100 + delivered.length, date: Math.floor(Date.now()/1000), chat: { id: 777, type: 'private' }, text: body.text } });
    }
    return json({ ok: true, result: true });
  }
  modelRequests.push(raw);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = { id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: { role: 'assistant', content: 'The browser I use lives on a private server. To sign in yourself, you need to open your OpenClaw Control UI and look for Live View.' }, finish_reason: null }] };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  chunk.choices = [{ index: 0, delta: {}, finish_reason: 'stop' }];
  res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const workspace = path.join(dir, 'workspace');
  mkdirSync(path.join(workspace, 'remote-connect'), { recursive: true });
  writeFileSync(path.join(workspace, 'remote-connect/session.mjs'), `console.log(JSON.stringify({url:'https://8examples.com/remote-connect/00000000-0000-4000-8000-000000000000',code:'000123',expiresAt:'2099-01-01T00:00:00Z'}));`);
  const config = path.join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({
    gateway: { mode: 'local', port, bind: 'loopback', auth: { mode: 'token', token: 'synthetic-gateway-test-only' } },
    agents: { defaults: { workspace, model: { primary: 'mock/mock' } } },
    session: { dmScope: 'per-channel-peer' },
    channels: { telegram: { enabled: true, botToken: '123456:synthetic-fixture-token', apiRoot: endpoint, dmPolicy: 'allowlist', allowFrom: ['777'], streaming: { mode: 'off' } } },
    browser: { enabled: false, profiles: { openclaw: { cdpUrl: endpoint } } },
    models: { providers: { mock: { baseUrl: endpoint+'/v1', apiKey: 'synthetic-model-key', api: 'openai-completions', models: [{ id: 'mock', name: 'Mock', contextWindow: 32000, maxTokens: 4096 }] } } },
    plugins: { allow: ['telegram', 'managed-remote-login'], load: { paths: [process.argv[2]] }, entries: { telegram: { enabled: true }, 'managed-remote-login': { enabled: true, hooks: { allowConversationAccess: true, allowPromptInjection: true } } } },
  }));
  const env = { PATH: process.env.PATH, OPENCLAW_CONFIG_PATH: config, OPENCLAW_STATE_DIR: path.join(dir, 'state') };
  await exec('openclaw', ['plugins', 'enable', 'telegram', '--accept-capabilities'], { env, timeout: 60000, maxBuffer: 65536 });
  gateway = spawn('openclaw', ['gateway', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [gateway.stdout, gateway.stderr]) stream.on('data', data => { startup = (startup + data).slice(-12000); });
  for (let i=0; i<150; i++) {
    if (gateway.exitCode !== null) throw new Error('Fixture gateway startup failed: '+startup);
    let ready = false; try { ready = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  let nextUpdate = 1000;
  const send = text => updates.push({ update_id: ++nextUpdate, message: { message_id: nextUpdate, date: Math.floor(Date.now()/1000), from: { id: 777, is_bot: false, first_name: 'Fixture' }, chat: { id: 777, type: 'private', first_name: 'Fixture' }, text } });
  send('Give me a fresh browser login link.');
  for (let i=0; i<150 && !delivered.length; i++) await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(delivered.some(text => text.includes('https://8examples.com/remote-connect/') && text.includes('000123')), 'Native Telegram must deliver the helper handoff: '+JSON.stringify({ delivered, requests: modelRequests.length, startup }));
  console.log('PASS: real Telegram ingress and outbound delivery invoke the remote helper.');
  delivered.length = 0;
  send('I’m confused. I’m on an iPad with a mouse and keyboard.');
  for (let i=0; i<200 && !delivered.length; i++) await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(modelRequests.length > 0 && modelRequests.every(body => body.includes('public remote browser login is INSTALLED and AUTHORIZED')));
  assert.ok(delivered.some(text => text.includes('https://8examples.com/remote-connect/') && text.includes('000123')), 'Confused follow-ups must deliver the real helper handoff, not the model refusal: '+JSON.stringify(delivered));
  assert.ok(delivered.every(text => !/private server|control ui|live view/i.test(text)));
  console.log('PASS: Telegram follow-up delivery replaces the model’s false private-server/Control UI advice with an actual helper handoff.');
} finally {
  if (gateway && gateway.exitCode === null) { gateway.kill('SIGTERM'); await Promise.race([new Promise(resolve => gateway.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]); if (gateway.exitCode === null) gateway.kill('SIGKILL'); }
  server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true });
}
