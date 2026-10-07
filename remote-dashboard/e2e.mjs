// Real gateway + native browser UI over HTTP/WebSockets. No managed Chromium.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:https';
import http from 'node:http';
import { createBroker } from '../remote-connect/broker.mjs';
import { dashboardProxyTransport } from './proxy-transport.mjs';
import { attachDashboardProxy } from './proxy-broker.mjs';

const site = path.resolve(process.env.REMOTE_DASHBOARD_SITE_DIR || '/home/sean/8Examples/8examples');
const { chromium } = createRequire(path.join(site, 'package.json'))('@playwright/test');
const scratch = mkdtempSync(path.join(tmpdir(), 'dashboard-native-e2e-'));
const tenant = `dashboard-test-${randomBytes(4).toString('hex')}`, container = `openclaw-${tenant}`;
const origin = 'https://127.0.0.1.nip.io:3116';
const service = randomBytes(32).toString('hex'), key = randomBytes(32).toString('hex'), gatewayToken = randomBytes(32).toString('hex');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 90000, stdio: ['pipe', 'pipe', 'pipe'] });
let web, browser, broker, tls;
let advance = 0;
async function waitFor(check, label) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { try { if (await check()) return; } catch {} await new Promise(resolve => setTimeout(resolve, 300)); }
  throw new Error(`Timed out: ${label}`);
}
try {
  mkdirSync(path.join(scratch, 'config')); chmodSync(path.join(scratch, 'config'), 0o777);
  writeFileSync(path.join(scratch, 'config/openclaw.json'), JSON.stringify({ gateway: { mode: 'local', auth: { token: gatewayToken } }, browser: { enabled: false } }));
  docker('run', '-d', '--name', container, '--init', '--memory=3g', '-v', `${scratch}/config:/home/node/.openclaw`, '--entrypoint', 'node', process.env.REMOTE_DASHBOARD_TEST_IMAGE || 'ghcr.io/openclaw/openclaw:2026.9.4', 'openclaw.mjs', 'gateway');
  await waitFor(() => docker('exec', container, 'node', '-e', "fetch('http://127.0.0.1:18789/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))").length === 0, 'gateway');
  broker = attachDashboardProxy(createBroker({ serviceToken: service, publicPath: 'remote-dashboard', recreateTransport: false, publicOrigin: origin, now: () => Date.now() + advance,
    tenantCredential: id => id === tenant ? key : undefined, createTransport: dashboardProxyTransport,
  }));
  await new Promise(resolve => broker.listen(18885, '127.0.0.1', resolve));
  const log = await import('node:fs').then(fs => fs.openSync(path.join(scratch, 'website.log'), 'w'));
  web = spawn('npm', ['run', 'start', '--', '--hostname', '127.0.0.1', '--port', '3114'], {
    cwd: site, detached: true, stdio: ['ignore', log, log], env: { ...process.env, E2E_TEST_BUILD: '1', CLAW_TEST_MODE: '1',
      DB_PATH: path.join(scratch, 'events.db'), REPLAY_DB_PATH: path.join(scratch, 'replay.db'),
      REMOTE_CONNECT_SERVICE_TOKEN: service, REMOTE_CONNECT_BROKER_URL: 'http://127.0.0.1:18885', REMOTE_DASHBOARD_BROKER_URL: 'http://127.0.0.1:18885', REMOTE_CONNECT_PUBLIC_ORIGIN: origin, REMOTE_DASHBOARD_DOMAIN: '127.0.0.1.nip.io' },
  });
  await waitFor(async () => (await fetch('http://127.0.0.1:3114/remote-dashboard/00000000-0000-4000-8000-000000000001')).ok, 'website');
  const cert = path.join(scratch, 'cert.pem'), certKey = path.join(scratch, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', certKey, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  tls = createServer({ key: readFileSync(certKey), cert: readFileSync(cert) }, (req, res) => {
    const upstream = http.request({ hostname: '127.0.0.1', port: 3114, path: req.url, method: req.method, headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  tls.on('upgrade', (req, socket, head) => {
    const upstream = http.request({ hostname: '127.0.0.1', port: 3114, path: req.url, headers: req.headers });
    upstream.on('upgrade', (res, stream, upstreamHead) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
      if (upstreamHead.length) socket.write(upstreamHead); if (head.length) stream.write(head);
      socket.pipe(stream); stream.pipe(socket); socket.on('error', () => stream.destroy()); stream.on('error', () => socket.destroy());
      socket.on('close', () => stream.destroy()); stream.on('close', () => socket.destroy());
    });
    upstream.on('response', res => { socket.end(`HTTP/1.1 ${res.statusCode} Rejected\r\nConnection: close\r\n\r\n`); res.resume(); });
    upstream.on('error', () => socket.destroy()); upstream.end();
  });
  await new Promise(resolve => tls.listen(3116, '0.0.0.0', resolve));
  browser = await chromium.launch({ headless: true, args: ['--no-proxy-server', '--host-resolver-rules=MAP *.127.0.0.1.nip.io 127.0.0.1'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(), requests = [], messages = [], errors = [];
  page.on('request', req => requests.push(req.url()));
  page.on('response', res => { if (res.status() >= 400) console.log('HTTP failure:', res.status(), new URL(res.url()).pathname); });
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text().slice(0, 350)); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => { socket.on('framereceived', event => { try { messages.push(JSON.parse(String(event.payload))); } catch {} }); });
  const create = async () => {
    const r = await context.request.post(`${origin}/api/remote-dashboard/sessions`, { headers: { authorization: `Bearer ${key}`, 'x-remote-tenant': tenant }, data: { tenant } });
    const session = await r.json(); assert.equal(r.status(), 200, JSON.stringify(session)); return session;
  };
  const session = await create();
  assert(!JSON.stringify(session).includes(gatewayToken));
  await page.goto(session.url);
  await page.getByLabel('Connection code').fill(session.code);
  await page.getByRole('button', { name: 'Open dashboard', exact: true }).click();
  await page.waitForURL(`https://dashboard-${session.id}.127.0.0.1.nip.io:3116/**`);
  console.log('Entered native origin:', page.url(), (await page.locator('body').innerText()).slice(0,700));
  await waitFor(() => messages.some(m => m.payload?.type === 'hello-ok'), 'native browser gateway handshake');
  await page.locator('openclaw-app').waitFor({ state: 'visible' });
  await waitFor(async () => (await page.locator('body').innerText()).length > 600, 'complete native dashboard rendering');
  await page.getByRole('button', { name: 'Close dashboard', exact: true }).waitFor();
  const cookies = await context.cookies();
  const cookie = cookies.find(c => c.name === '__Host-openclaw_dashboard');
  assert(cookie?.httpOnly && cookie.secure && cookie.sameSite === 'Strict'); assert.equal(cookie.path, '/');
  assert.equal(cookie.domain, `dashboard-${session.id}.127.0.0.1.nip.io`);
  assert(!JSON.stringify(messages).includes(gatewayToken)); assert(!JSON.stringify(messages).includes('deviceToken'));
  assert.equal((await page.request.get(`${origin}/api/remote-connect/${session.id}/frame`)).status(), 401);
  assert.equal((await page.request.post(page.url() + '_dashboard/close', { headers: { origin: 'https://sibling.localhost:3116' } })).status(), 403);
  await page.reload();
  await page.getByRole('button', { name: 'Close dashboard', exact: true }).waitFor();
  await page.locator('openclaw-app').waitFor({ state: 'visible' });
  await waitFor(async () => (await page.locator('body').innerText()).length > 600, 'complete native dashboard rendering');
  mkdirSync('artifacts/remote-dashboard', { recursive: true }); await page.screenshot({ path: 'artifacts/remote-dashboard/native-dashboard.png' });
  console.log('Native UI visible; browser text:', (await page.locator('body').innerText()).slice(0, 1000));
  console.log('Browser errors:', errors.slice(0, 8));
  await page.getByRole('button', { name: 'Close dashboard', exact: true }).click();
  await page.getByRole('heading', { name: 'Dashboard closed', exact: true }).waitFor();
  assert.equal((await page.request.get(new URL('/', page.url()).href)).status(), 401);
  assert(!(await context.cookies()).some(c => c.name === '__Host-openclaw_dashboard'));
  const expiring = await create();
  await page.goto(expiring.url); await page.getByLabel('Connection code').fill(expiring.code); await page.getByRole('button', { name: 'Open dashboard', exact: true }).click();
  await page.getByRole('button', { name: 'Close dashboard', exact: true }).waitFor();
  await waitFor(async () => (await page.locator('body').innerText()).length > 600, 'expiring dashboard rendering'); advance = 16 * 60000;
  await page.getByRole('heading', { name: 'Dashboard closed', exact: true }).waitFor({ timeout: 25000 });
  assert(!requests.some(url => /googletagmanager|google-analytics|\/api\/replay|\/api\/log|\/frame$|\/input$/.test(url)));
  assert.equal(docker('exec', container, 'sh', '-c', 'pgrep -f "[c]hromium" || true').trim(), '');
  console.log('PASS: native HTTP/WebSocket dashboard, gateway auth, origin isolation, scoped cookies, CSRF, refresh, close, expiry, no browser streaming.');
} catch (error) {
  if (process.env.KEEP_DASHBOARD_TEST_ARTIFACTS === '1') console.log('Test directory:', scratch);
  throw error;
} finally {
  await browser?.close(); broker?.shutdown(); tls?.closeAllConnections(); tls?.close();
  if (web?.pid) try { process.kill(-web.pid, 'SIGTERM'); } catch {}
  try { docker('rm', '-f', container); } catch {}
  if (process.env.KEEP_DASHBOARD_TEST_ARTIFACTS !== '1') rmSync(scratch, { recursive: true, force: true });
}
