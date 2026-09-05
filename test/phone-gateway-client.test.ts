import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../templates/workspace/phone/gateway.mjs', import.meta.url));
const key = `pgw_${'b'.repeat(32)}`;

function run(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | string; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [helper, ...args], { env: { ...process.env, ...env } },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}

test('phone CLI authenticates reads and calls, preserves JSON, and reports failures without retrying or leaking keys', async (t) => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'phone-client-'));
  const requests: { method?: string; url?: string; authorization?: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/unauthorized') {
      res.writeHead(401).end(JSON.stringify({ error: `Rejected ${key}` }));
    } else if (req.url === '/orchestrations') {
      res.writeHead(body === '{}' ? 400 : 202).end(JSON.stringify(body === '{}' ? { error: 'Required' } : { orchestrationId: 'test-call' }));
    } else {
      res.end(JSON.stringify([{ phoneNumber: '+15555550123' }]));
    }
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
    rmSync(scratch, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const env = { PHONE_GATEWAY_URL: `http://127.0.0.1:${address.port}`, PHONE_GATEWAY_API_KEY: key };

  const numbers = await run(['GET', '/numbers'], env);
  assert.equal(numbers.code, 0);
  assert.deepEqual(JSON.parse(numbers.stdout), { status: 200, body: [{ phoneNumber: '+15555550123' }] });
  const payload = { to: '+15555550124', goal: 'Ask about "Friday" at O\'Brien’s. Literal $HOME and `date`.\nConfirm time.' };
  const requestFile = path.join(scratch, 'call request.json');
  writeFileSync(requestFile, JSON.stringify(payload));
  const call = await run(['POST', '/orchestrations', requestFile], env);
  assert.equal(call.code, 0);
  assert.equal(JSON.parse(call.stdout).status, 202);
  assert.deepEqual(JSON.parse(requests[1].body), payload);

  // Missing required fields is a safe authentication probe: no destination is sent.
  const probe = await run(['POST', '/orchestrations'], env);
  assert.equal(probe.code, 1);
  assert.deepEqual(JSON.parse(probe.stdout), { status: 400, body: { error: 'Required' } });
  const history = await run(['GET', '/sms?days=7&limit=50'], env);
  assert.equal(history.code, 0);
  assert.equal(requests[3].url, '/sms?days=7&limit=50');
  const failed = await run(['GET', '/unauthorized'], env);
  assert.equal(failed.code, 1);
  assert.deepEqual(JSON.parse(failed.stdout), { status: 401, body: { error: 'Rejected [REDACTED]' } });
  assert.equal(requests.length, 5); // Neither the call nor any failure was retried.
  assert.ok(requests.every((req) => req.authorization === `Bearer ${key}`));
  assert.ok([numbers, call, probe, history, failed].every((r) => !`${r.stdout}${r.stderr}`.includes(key)));
});

test('phone CLI refuses missing credentials, malformed JSON, external paths, and redirects', async (t) => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(302, { location: '/must-not-follow' }).end();
  });
  const scratch = mkdtempSync(path.join(tmpdir(), 'phone-client-errors-'));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    rmSync(scratch, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const env = { PHONE_GATEWAY_URL: `http://127.0.0.1:${address.port}`, PHONE_GATEWAY_API_KEY: key };
  const missing = await run(['GET', '/numbers'], { ...env, PHONE_GATEWAY_API_KEY: '' });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Missing tenant phone gateway credential/);
  for (const route of ['https://other.example/numbers', '//other.example/numbers', '/\\other.example/numbers']) {
    const result = await run(['GET', route], env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /gateway/);
  }
  const requestFile = path.join(scratch, 'bad.json');
  writeFileSync(requestFile, `{"secret":"${key}",BROKEN}`);
  const malformed = await run(['POST', '/orchestrations', requestFile], env);
  assert.equal(malformed.code, 1);
  assert.ok(!malformed.stderr.includes(key));
  assert.equal(requests, 0);
  const redirect = await run(['GET', '/redirect'], env);
  assert.equal(redirect.code, 1);
  assert.equal(requests, 1);
});
