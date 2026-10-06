// Real OpenClaw dashboard, isolated Chromium context, broker, and website.
// Run after: E2E_TEST_BUILD=1 npm --prefix ../8examples run build
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { createBroker } from '../remote-connect/broker.mjs';
import { dashboardTransport } from './transport.mjs';
import { testHttps } from '../remote-connect/test-https.mjs';

const site = path.resolve(process.env.REMOTE_DASHBOARD_SITE_DIR || '../8examples');
const { chromium } = createRequire(path.join(site, 'package.json'))('@playwright/test');
const scratch = mkdtempSync(path.join(tmpdir(), 'dashboard-e2e-'));
const tenant = `dashboard-test-${randomBytes(4).toString('hex')}`, container = `openclaw-${tenant}`;
const origin = 'http://127.0.0.1:3114', viewerOrigin = 'https://127.0.0.1:3115';
const service = randomBytes(32).toString('hex'), key = randomBytes(32).toString('hex'), gatewayToken = randomBytes(32).toString('hex');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 90000, stdio: ['pipe', 'pipe', 'pipe'] });
let web, browser, broker, tls;
const transports = [];
async function waitFor(check, label) {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    try { if (await check()) return; } catch { /* wait for startup */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  mkdirSync(path.join(scratch, 'config'), { recursive: true });
  mkdirSync(path.join(scratch, 'browser-cache'));
  writeFileSync(path.join(scratch, 'config/openclaw.json'), JSON.stringify({
    gateway: { mode: 'local', auth: { token: gatewayToken } },
    browser: { enabled: true, headless: false, noSandbox: true, defaultProfile: 'openclaw', extraArgs: ['--no-sandbox'] },
  }));
  docker('run', '-d', '--name', container, '--init', '--shm-size=1g', '--memory=3g',
    '-e', 'DISPLAY=:99', '-e', 'PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright',
    '-v', `${path.join(homedir(), '.cache/ms-playwright')}:/opt/ms-playwright:ro`,
    '-v', `${scratch}/browser-cache:/home/node/.cache`, '-v', `${scratch}/config:/home/node/.openclaw`,
    '--entrypoint', '/bin/bash', process.env.REMOTE_DASHBOARD_TEST_IMAGE || 'ghcr.io/openclaw/openclaw:2026.8.1-browser',
    '-lc', 'Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 & exec node openclaw.mjs gateway');
  await waitFor(() => docker('exec', container, 'node', '-e', "fetch('http://127.0.0.1:18789/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))").length === 0, 'gateway');
  docker('exec', container, 'openclaw', 'browser', '--browser-profile', 'openclaw', 'start');
  const readTabs = () => JSON.parse(docker('exec', container, 'node', '-e', "fetch('http://127.0.0.1:18800/json/list').then(r=>r.json()).then(x=>console.log(JSON.stringify(x.map(t=>({id:t.id,type:t.type})))))"));
  // Keep an ordinary managed-browser page, which must never enter this viewer.
  docker('exec', container, 'node', '-e', "fetch('http://127.0.0.1:18800/json/new?about:blank',{method:'PUT'}).then(r=>r.json()).then(()=>{})");
  const before = readTabs().filter(t => t.type === 'page').map(t => t.id);
  assert(before.length > 0);
  broker = createBroker({ serviceToken: service, publicPath: 'remote-dashboard', recreateTransport: false, publicOrigin: origin,
    tenantCredential: id => id === tenant ? key : undefined,
    createTransport: id => { const t = dashboardTransport(id), request = t.request.bind(t); t.request = async (...args) => { try { return await request(...args); } catch (error) { console.log('Transport failure category:', error.code); throw error; } }; transports.push(t); return t; },
  });
  await new Promise(resolve => broker.listen(18885, '127.0.0.1', resolve));
  web = spawn('npm', ['run', 'start', '--', '--hostname', '127.0.0.1', '--port', '3114'], {
    cwd: site, detached: true, stdio: 'ignore', env: { ...process.env, E2E_TEST_BUILD: '1', CLAW_TEST_MODE: '1',
      DB_PATH: path.join(scratch, 'events.db'), REPLAY_DB_PATH: path.join(scratch, 'replay.db'),
      REMOTE_CONNECT_SERVICE_TOKEN: service, REMOTE_DASHBOARD_BROKER_URL: 'http://127.0.0.1:18885', REMOTE_CONNECT_PUBLIC_ORIGIN: origin },
  });
  await waitFor(async () => (await fetch(origin + '/remote-dashboard/00000000-0000-4000-8000-000000000001')).ok, 'website');
  tls = await testHttps(scratch, origin, viewerOrigin);
  const create = await fetch(origin + '/api/remote-dashboard/sessions', { method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'x-remote-tenant': tenant, 'Content-Type': 'application/json' }, body: JSON.stringify({ tenant }) });
  const session = await create.json();
  assert.equal(create.status, 200, JSON.stringify(session));
  assert(!JSON.stringify(session).includes(gatewayToken));
  console.log('Real dashboard authenticated inside a dedicated incognito context.');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 1050 } });
  const page = await context.newPage(), requests = [];
  page.on('request', r => requests.push(r.url()));
  await page.goto(session.url.replace(origin, viewerOrigin));
  await page.getByLabel('Connection code').fill(session.code);
  await page.getByRole('button', { name: 'Open dashboard', exact: true }).click();
  await page.getByAltText('Live remote browser.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Close dashboard', exact: true }).waitFor();
  const cookie = (await context.cookies()).find(c => c.name.startsWith('__Secure-dashboard_'));
  assert(cookie?.httpOnly && cookie.secure && cookie.sameSite === 'Strict');
  assert.equal(cookie.path, `/api/remote-dashboard/${session.id}`);
  const state = await (await page.request.get(`${viewerOrigin}/api/remote-dashboard/${session.id}/state`)).json();
  assert(!JSON.stringify(state).includes(gatewayToken));
  assert(state.tabs.every(t => !before.includes(t.id)));
  assert(state.tabs.every(t => t.url === 'about:blank'));
  assert.equal((await page.request.post(`${viewerOrigin}/api/remote-dashboard/${session.id}/input`, { headers: { origin: 'https://untrusted.example' }, data: { kind: 'text', text: 'blocked' } })).status(), 403);
  const stranger = await browser.newContext({ ignoreHTTPSErrors: true });
  assert.equal((await stranger.request.post(`${viewerOrigin}/api/remote-dashboard/${session.id}/unlock`, { headers: { origin: viewerOrigin }, data: { code: session.code } })).status(), 410);
  assert.equal((await stranger.request.get(`${viewerOrigin}/api/remote-dashboard/${session.id}/frame`)).status(), 401);
  await stranger.close();
  // A safe navigation click exercises the actual input path without changing
  // configuration or sending a message. The sidebar remains in the same context.
  await page.getByRole('button', { name: 'Tab', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Close dashboard', exact: true }).waitFor();
  await page.getByAltText('Live remote browser.', { exact: false }).waitFor();
  mkdirSync('artifacts/remote-dashboard', { recursive: true });
  await page.screenshot({ path: 'artifacts/remote-dashboard/dashboard.png' });
  await page.getByRole('button', { name: 'Close dashboard', exact: true }).click();
  await page.getByRole('heading', { name: 'Dashboard closed', exact: true }).waitFor();
  assert.equal((await page.request.get(`${viewerOrigin}/api/remote-dashboard/${session.id}/frame`)).status(), 401);
  await waitFor(() => { const ids = readTabs().filter(t => t.type === 'page').map(t => t.id); return ids.length === before.length && before.every(id => ids.includes(id)); }, 'private dashboard context disposed; ordinary tabs preserved');
  assert(!requests.some(url => /googletagmanager|google-analytics|\/api\/replay|\/api\/log/.test(url)));
  console.log('PASS: real dashboard, OTP, isolation, HTTPS cookie, CSRF, refresh, input, completion, and context cleanup.');
} finally {
  await browser?.close();
  for (const t of transports) t.close();
  broker?.shutdown();
  await tls?.close();
  if (web?.pid) try { process.kill(-web.pid, 'SIGTERM'); } catch { /* stopped */ }
  try { docker('rm', '-f', container); } catch { /* absent */ }
  rmSync(scratch, { recursive: true, force: true });
}
