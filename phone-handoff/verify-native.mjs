// Exercises the installed OpenClaw gateway with synthetic Telegram, phone and
// model APIs. It never inherits production credentials or accesses live chats.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const dir = mkdtempSync(path.join(tmpdir(), 'phone-handoff-native-'));
const requests = [], delivered = [], updates = [], calls = [];
let gateway, startup = '', callbacks = 0, nextUpdate = 1000, currentText = '', callbackIssued = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, description, attempts = 250) => {
  for (let i = 0; i < attempts; i++) { if (await predicate()) return; await sleep(200); }
  throw new Error(description + ': ' + startup);
};
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const json = result => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); };
  if (req.url.startsWith('/orchestrations')) {
    assert.equal(req.headers.authorization, 'Bearer synthetic-phone-key');
    if (req.method === 'POST') { callbacks++; return json({ orchestrationId: 'callback-fixture' }); }
    if (req.url.includes('?')) return json({ count: calls.length, orchestrations: calls });
    return json(calls.find(call => req.url.endsWith('/' + call.id)) || { id: 'callback-fixture', status: 'ended', direction: 'outbound', turns: [{ role: 'caller', text: 'Yes, we are confirmed.' }] });
  }
  if (req.url.startsWith('/bot')) {
    const method = req.url.split('/').pop();
    if (method === 'getMe') return json({ ok: true, result: { id: 123456, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' } });
    if (method === 'getWebhookInfo') return json({ ok: true, result: { url: '', pending_update_count: 0 } });
    if (method === 'getUpdates') { await sleep(100); return json({ ok: true, result: updates.splice(0) }); }
    if (method === 'sendMessage' || method === 'editMessageText') {
      let body; try { body = JSON.parse(raw); } catch { body = Object.fromEntries(new URLSearchParams(raw)); }
      assert.equal(String(body.chat_id), '777', 'Only the configured private owner may receive a notice');
      delivered.push(body.text || '');
      return json({ ok: true, result: { message_id: 100 + delivered.length, date: Math.floor(Date.now() / 1000), chat: { id: 777, type: 'private' }, text: body.text } });
    }
    return json({ ok: true, result: true });
  }
  const body = JSON.parse(raw); requests.push(body);
  const last = body.messages.at(-1);
  const callback = !callbackIssued && currentText.includes('confirm that time');
  if (callback) {
    callbackIssued = true;
    assert.ok(raw.includes(currentText), 'The model must receive the native Telegram user request');
    assert.ok(raw.includes('Joseph') && raw.includes('America/Edmonton'), 'The next owner turn must contain saved call context');
    assert.ok(raw.includes('pendingCount'), 'Saved call context must be injected, independently of transcript mirroring');
    assert.ok(body.tools.some(tool => tool.function.name === 'phone_handoff'), 'The native runtime must expose the handoff tool');
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const delta = callback ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-' + requests.length, type: 'function', function: { name: 'phone_handoff', arguments: JSON.stringify({ action: 'callback', callId: 'call-fixture', goal: 'Confirm the meeting with Joseph at the agreed time.' }) } }] } : { role: 'assistant', content: last.role === 'tool' ? 'The saved callback attempt is being tracked.' : 'Ready for the phone conversation.' };
  const chunk = { id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason: null }] };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  chunk.choices = [{ index: 0, delta: {}, finish_reason: callback ? 'tool_calls' : 'stop' }];
  res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
});
async function stop() {
  if (gateway && gateway.exitCode === null) {
    gateway.kill('SIGTERM');
    await Promise.race([new Promise(resolve => gateway.once('exit', resolve)), sleep(5000)]);
    if (gateway.exitCode === null) { gateway.kill('SIGKILL'); await new Promise(resolve => gateway.once('exit', resolve)); }
  }
}
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const workspace = path.join(dir, 'workspace'); mkdirSync(workspace);
  const config = path.join(dir, 'config.json'), state = path.join(dir, 'state');
  writeFileSync(config, JSON.stringify({
    gateway: { mode: 'local', port, bind: 'loopback', auth: { mode: 'token', token: 'synthetic-gateway-test-only' } },
    agents: { defaults: { workspace, model: { primary: 'mock/mock' } } },
    session: { dmScope: 'per-channel-peer' },
    channels: { telegram: { enabled: true, botToken: '123456:synthetic-fixture-token', apiRoot: endpoint, dmPolicy: 'allowlist', allowFrom: ['777'], streaming: { mode: 'off' } } },
    models: { providers: { mock: { baseUrl: endpoint + '/v1', apiKey: 'synthetic-model-key', api: 'openai-completions', models: [{ id: 'mock', name: 'Mock', contextWindow: 64000, maxTokens: 4096 }] } } },
    plugins: { allow: ['telegram'], load: { paths: [] }, entries: { telegram: { enabled: true } } },
  }));
  const env = { PATH: process.env.PATH, OPENCLAW_CONFIG_PATH: config, OPENCLAW_STATE_DIR: state, PHONE_GATEWAY_URL: endpoint, PHONE_GATEWAY_API_KEY: 'synthetic-phone-key' };
  await exec('openclaw', ['plugins', 'enable', 'telegram', '--accept-capabilities'], { env, timeout: 60000, maxBuffer: 65536 });
  async function launch() {
    startup = '';
    gateway = spawn('openclaw', ['gateway', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [gateway.stdout, gateway.stderr]) stream.on('data', data => { startup = (startup + data).slice(-16000); });
    await until(async () => { if (gateway.exitCode !== null) throw new Error(startup); try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { return false; } }, 'Gateway readiness');
  }
  const send = text => {
    currentText = text; callbackIssued = false;
    updates.push({ update_id: ++nextUpdate, message: { message_id: nextUpdate, date: Math.floor(Date.now() / 1000), from: { id: 777, is_bot: false, first_name: 'Fixture' }, chat: { id: 777, type: 'private', first_name: 'Fixture' }, text } });
  };
  await launch(); send('Hello');
  await until(() => delivered.length, 'Initial native Telegram reply');
  assert.ok(requests.every(body => !JSON.stringify(body).includes('Saved phone call context')));
  const update = JSON.parse(readFileSync(config, 'utf8'));
  update.plugins.allow.push('managed-phone-handoff');
  update.plugins.load.paths.push(process.argv[2]);
  update.plugins.entries['managed-phone-handoff'] = { enabled: true, hooks: { allowConversationAccess: true, allowPromptInjection: true }, config: { owner: { channel: 'telegram', peer: '777' }, pollMs: 1000 } };
  writeFileSync(config, JSON.stringify(update));
  await until(() => startup.includes('managed-phone-handoff active'), 'Plugin installation reload');
  calls.push({ id: 'call-fixture', direction: 'inbound', startedAt: new Date().toISOString(), status: 'ended', from: '+15555550123', to: '+15555550124', turns: [{ role: 'caller', text: 'This is Joseph. Can we meet September 16 at 10 AM America/Edmonton?' }, { role: 'agent', text: 'I will ask the owner to confirm.' }] });
  await until(() => delivered.some(text => text.includes('Call reference: call-fixture')), 'Native private call notification');
  const notices = () => delivered.filter(text => text.includes('Call reference: call-fixture')).length;
  assert.equal(notices(), 1);
  await until(() => {
    const file = readdirSync(dir, { recursive: true }).find(file => file.endsWith('inbox.sqlite'));
    if (!file) return false;
    const db = new DatabaseSync(path.join(dir, file), { readOnly: true });
    try { return JSON.parse(db.prepare('SELECT body FROM attempts WHERE id=?').get('notice:call-fixture')?.body || '{}').mirrored; }
    finally { db.close(); }
  }, 'Supported transcript mirror');
  console.log('PASS: hot installation delivers one notice to the private Telegram owner and saves it in the native transcript.');
  await stop(); await launch();
  await until(() => startup.includes('managed-phone-handoff active'), 'Plugin restart');
  let before = delivered.length;
  send('Yes, confirm that time.');
  await until(() => delivered.length > before && callbacks === 1, 'Callback from native Telegram tool execution');
  await stop(); await launch();
  before = delivered.length;
  send('Yes, confirm that time again.');
  await until(() => delivered.length > before, 'Repeated confirmation reply');
  assert.equal(callbacks, 1, 'A repeated confirmation across a restart must not place another call');
  assert.equal(notices(), 1, 'Restart must not resend the notification');
  console.log('PASS: owner replies receive durable call context after restart; the native tool creates exactly one callback across repeated requests and another restart.');
} catch (error) {
  console.error(JSON.stringify({ callbacks, delivered, requests: requests.map(body => ({ messages: body.messages.map(message => ({ role: message.role, content: JSON.stringify(message.content).slice(-500) })), tools: body.tools?.map(tool => tool.function.name) })) }));
  throw error;
} finally {
  await stop(); server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true });
}
