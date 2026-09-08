// Run inside an OpenClaw container with the plugin copied to argv[2]. Uses
// only a local mock model and isolated state: no customer conversation or API.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const dir = mkdtempSync(path.join(tmpdir(), 'remote-hooks-runtime-'));
const requests = [];
let gateway;
const server = http.createServer(async (req, res) => {
  if (req.url === '/json/list') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ id: 'AAAABBBBCCCCDDDDEEEEFFFF00001111', type: 'page', url: 'https://example.com' }]));
    return;
  }
  let body = '';
  for await (const part of req) body += part;
  requests.push(body);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = { id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: { role: 'assistant', content: 'Ready.' }, finish_reason: null }] };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  chunk.choices = [{ index: 0, delta: {}, finish_reason: 'stop' }];
  res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const workspace = path.join(dir, 'workspace');
  mkdirSync(path.join(workspace, 'remote-connect'), { recursive: true });
  writeFileSync(path.join(workspace, 'remote-connect/session.mjs'), `import assert from 'node:assert/strict'; assert.equal(process.argv[2], 'create'); assert.equal(process.argv[3], 'AAAABBBBCCCCDDDDEEEEFFFF00001111'); console.log(JSON.stringify({url:'https://8examples.com/remote-connect/00000000-0000-4000-8000-000000000000',code:'000123',expiresAt:'2099-01-01T00:00:00Z'}));`);
  const config = path.join(dir, 'config.json');
  const reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const gatewayPort = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  writeFileSync(config, JSON.stringify({
    gateway: { mode: 'local', port: gatewayPort, bind: 'loopback', auth: { mode: 'token', token: 'synthetic-gateway-smoke-test-only' } },
    agents: { defaults: { workspace, model: { primary: 'mock/mock' } } },
    browser: { enabled: false, profiles: { openclaw: { cdpUrl: `http://127.0.0.1:${server.address().port}`, color: '#FF4500' } } },
    models: { providers: { mock: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'synthetic-test-key', api: 'openai-completions', models: [{ id: 'mock', name: 'Mock', contextWindow: 32000, maxTokens: 4096 }] } } },
    plugins: { allow: ['managed-remote-login'], load: { paths: [process.argv[2]] }, entries: { 'managed-remote-login': { enabled: true, hooks: { allowConversationAccess: true, allowPromptInjection: true } } } },
  }));
  // Do not inherit channel tokens or provider keys from the actual Claw.
  const env = { PATH: process.env.PATH, OPENCLAW_CONFIG_PATH: config, OPENCLAW_STATE_DIR: path.join(dir, 'state') };
  gateway = spawn('openclaw', ['gateway', '--port', String(gatewayPort)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let startup = '';
  for (const stream of [gateway.stdout, gateway.stderr]) stream.on('data', chunk => { startup = (startup + chunk).slice(-4000); });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (gateway.exitCode !== null) throw new Error(`Isolated gateway failed to start: ${startup}`);
    try { ready = (await fetch(`http://127.0.0.1:${gatewayPort}/healthz`)).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(ready, 'Isolated gateway starts');
  const { stdout } = await exec('openclaw', ['agent', '--agent', 'main', '--session-key', 'agent:main:telegram:direct:smoke', '--message', "The browser link you gave me won't open on my phone. Can you get me connected so I can sign in myself?", '--timeout', '60', '--json'], {
    env, timeout: 90000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.ok(stdout.includes('https://8examples.com/remote-connect/00000000-0000-4000-8000-000000000000'));
  assert.ok(stdout.includes('000123'), 'Leading zeroes are preserved');
  assert.equal(requests.length, 0, 'Explicit handoff creates the connection without relying on a model');
  await exec('openclaw', ['agent', '--agent', 'main', '--session-key', 'runtime-context-smoke', '--message', 'Say ready.', '--timeout', '60', '--json'], { env, timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(requests.length, 1, 'Unrelated turns still use the normal model');
  assert.ok(requests.every(body => body.includes('public remote browser login is INSTALLED and AUTHORIZED')), 'The provider must receive the runtime system context');
  console.log('PASS: native OpenClaw creates an explicit handoff directly, preserves the six-digit code, and injects the managed capability into normal model requests.');
} finally {
  if (gateway && gateway.exitCode === null) {
    gateway.kill('SIGTERM');
    await Promise.race([new Promise(resolve => gateway.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (gateway.exitCode === null) gateway.kill('SIGKILL');
  }
  server.closeAllConnections();
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
