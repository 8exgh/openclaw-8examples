// Full local integration: real OpenClaw gateway + graphical Chromium in an
// isolated container, real broker, production Next server, and a human browser.
// Prerequisites: site E2E build, its Playwright Chromium, Docker browser image.
//   E2E_TEST_BUILD=1 npm --prefix ../8examples run build
//   node remote-connect/e2e.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { createBroker } from './broker.mjs';
import { browserTransport } from './transport.mjs';
import { installRemoteWorkspace } from './workspace.mjs';

const siteDir = path.resolve(process.env.REMOTE_CONNECT_SITE_DIR || '../8examples');
const { chromium } = createRequire(path.join(siteDir, 'package.json'))('@playwright/test');
const scratch = mkdtempSync(path.join(tmpdir(), 'remote-login-e2e-'));
const tenant = `remote-test-${randomBytes(4).toString('hex')}`;
const container = `openclaw-${tenant}`;
const origin = 'http://127.0.0.1:3104';
const serviceToken = randomBytes(32).toString('hex');
const ownerKey = 'e'.repeat(64);
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 90000, stdio: ['pipe', 'pipe', 'pipe'] });
let web, browser, broker;
async function waitFor(check, label) {
  const deadline = Date.now() + 60000;
  let last;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
try {
  mkdirSync(path.join(scratch, 'config'), { recursive: true });
  mkdirSync(path.join(scratch, 'browser-cache'), { recursive: true });
  installRemoteWorkspace(scratch, tenant, origin);
  writeFileSync(path.join(scratch, 'workspace/remote-connect/account.json'), JSON.stringify({ tenant, token: ownerKey, origin }));
  writeFileSync(path.join(scratch, 'config/openclaw.json'), JSON.stringify({
    gateway: { mode: 'local', auth: { token: randomBytes(24).toString('hex') } },
    // This isolated test fixture lives on loopback; permit only that exact host.
    browser: { enabled: true, headless: false, noSandbox: true, defaultProfile: 'openclaw', extraArgs: ['--no-sandbox'], ssrfPolicy: { allowedHostnames: ['127.0.0.1'] } },
    agents: { defaults: { workspace: '/home/node/.openclaw/workspace' } },
  }));
  writeFileSync(path.join(scratch, 'fixture.mjs'), `
    import { createServer } from 'node:http';
    createServer(async (req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (req.url === '/login' && req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk;
        const form = new URLSearchParams(body);
        if (form.get('username') !== 'remote-test@example.com' || form.get('password') !== 'synthetic-Påss!23') { res.statusCode = 400; res.end('Wrong test credentials'); return; }
        res.writeHead(303, { 'set-cookie': 'signed_in=yes; HttpOnly; SameSite=Lax; Path=/', location: '/account' }); res.end(); return;
      }
      if (req.url === '/account') { res.end(req.headers.cookie?.includes('signed_in=yes') ? '<h1>Signed in successfully</h1><p>Login persisted in the Claw browser.</p>' : 'Not signed in'); return; }
      if (req.url === '/popup') { res.end('<h1>Verification popup</h1><button style="position:absolute;left:40px;top:100px;height:60px;width:200px" onclick="window.close()">Return to login</button>'); return; }
      res.end('<style>body{font:24px sans-serif;padding:30px}input,button{display:block;font:24px sans-serif;margin:20px 0;padding:12px;width:360px}</style><h1>Remote login test</h1><form action="/login" method="post"><input name="username" aria-label="Username" placeholder="Username"/><input name="password" aria-label="Password" type="password" placeholder="Password"/><button>Sign in</button></form><a style="position:absolute;left:500px;top:100px" href="/popup" target="_blank">Open verification popup</a><div style="height:1200px"></div><p>Scroll works</p>');
    }).listen(18801, '127.0.0.1');
  `);
  docker('run', '-d', '--name', container, '--init', '--shm-size=1g', '--memory=3g',
    '-e', 'DISPLAY=:99', '-e', 'PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright',
    '-v', `${path.join(homedir(), '.cache/ms-playwright')}:/opt/ms-playwright:ro`,
    '-v', `${scratch}/browser-cache:/home/node/.cache`, '-v', `${scratch}/config:/home/node/.openclaw`,
    '-v', `${scratch}/workspace:/home/node/.openclaw/workspace`, '-v', `${scratch}/fixture.mjs:/tmp/remote-fixture.mjs:ro`,
    '--entrypoint', '/bin/bash', process.env.REMOTE_CONNECT_TEST_IMAGE || 'ghcr.io/openclaw/openclaw:2026.8.1-browser',
    '-lc', 'Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 & node /tmp/remote-fixture.mjs & exec node openclaw.mjs gateway');
  await waitFor(() => {
    try { return docker('exec', container, 'node', '-e', "fetch('http://127.0.0.1:18789/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))").length === 0; } catch { return false; }
  }, 'OpenClaw gateway');
  docker('exec', container, 'openclaw', 'browser', '--browser-profile', 'openclaw', 'start');
  docker('exec', container, 'openclaw', 'browser', '--browser-profile', 'openclaw', 'open', 'http://127.0.0.1:18801/', '--json');
  const tabs = JSON.parse(docker('exec', container, 'openclaw', 'browser', '--browser-profile', 'openclaw', 'tabs', '--json'));
  const target = (tabs.tabs || tabs).find((tab) => tab.url === 'http://127.0.0.1:18801/');
  assert.ok(target, 'OpenClaw opened the login tab');
  const targetId = target.targetId || target.id;
  console.log('Real OpenClaw gateway opened its graphical browser.');

  broker = createBroker({ serviceToken, publicOrigin: origin, tenantCredential: (id) => id === tenant ? ownerKey : undefined, createTransport: browserTransport });
  await new Promise((resolve) => broker.listen(18881, '127.0.0.1', resolve));
  web = spawn('npm', ['run', 'start', '--', '--hostname', '127.0.0.1', '--port', '3104'], {
    cwd: siteDir, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, E2E_TEST_BUILD: '1', CLAW_TEST_MODE: '1', DB_PATH: path.join(scratch, 'events.db'), REPLAY_DB_PATH: path.join(scratch, 'replay.db'),
      REMOTE_CONNECT_SERVICE_TOKEN: serviceToken, REMOTE_CONNECT_BROKER_URL: 'http://127.0.0.1:18881', REMOTE_CONNECT_PUBLIC_ORIGIN: origin },
  });
  let webErrors = '';
  web.stderr.on('data', (chunk) => { webErrors = (webErrors + chunk).slice(-2000); });
  await waitFor(async () => (await fetch(origin + '/remote-connect/00000000-0000-4000-8000-000000000000')).ok, 'website');
  // Run the very helper installed in each Claw; local Docker bridge cannot
  // reach host loopback, so invoke the identical helper from its local mount.
  const helper = spawn('node', [path.join(scratch, 'workspace/remote-connect/session.mjs'), 'create', targetId], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', helperErrors = '';
  helper.stdout.on('data', (chunk) => output += chunk);
  helper.stderr.on('data', (chunk) => helperErrors += chunk);
  await new Promise((resolve, reject) => helper.on('exit', (code) => code ? reject(new Error(helperErrors)) : resolve()));
  const session = JSON.parse(output);
  assert.match(session.code, /^\d{6}$/);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  const requests = [];
  page.on('request', (req) => requests.push(req.url()));
  await page.goto(session.url);
  await page.getByLabel('Connection code').fill(session.code === '000000' ? '000001' : '000000');
  await page.getByRole('button', { name: 'Connect to browser' }).click();
  await page.getByRole('alert').filter({ hasText: 'incorrect' }).waitFor();
  await page.getByLabel('Connection code').fill(session.code);
  await page.getByRole('button', { name: 'Connect to browser' }).click();
  await page.getByAltText('Live remote browser.', { exact: false }).waitFor();
  const cookie = (await context.cookies()).find((item) => item.name.startsWith('__Secure-remote_'));
  assert.ok(cookie?.httpOnly && cookie.secure && cookie.sameSite === 'Strict', 'Viewer cookie is HttpOnly, Secure, SameSite Strict');
  assert.equal((await page.request.post(`${origin}/api/remote-connect/${session.id}/input`, { headers: { origin: 'https://untrusted.example' }, data: { kind: 'text', text: 'blocked' } })).status(), 403);
  const stranger = await browser.newContext();
  assert.equal((await stranger.request.get(`${origin}/api/remote-connect/${session.id}/frame`)).status(), 401);
  const replay = await stranger.request.post(`${origin}/api/remote-connect/${session.id}/unlock`, { headers: { origin }, data: { code: session.code } });
  assert.equal(replay.status(), 410);
  await stranger.close();

  // The fixture layout gives stable browser coordinates, transformed through
  // the displayed frame exactly as a human's clicks are.
  async function click(x, y) {
    const box = await page.getByAltText('Live remote browser.', { exact: false }).boundingBox();
    const metrics = await page.evaluate(() => { const img = document.querySelector('img'); return { w: img.naturalWidth, h: img.naturalHeight }; });
    await page.mouse.click(box.x + x * box.width / metrics.w, box.y + y * box.height / metrics.h);
  }
  await click(550, 110);
  await waitFor(async () => (await page.getByLabel('Browser tab').locator('option').count()) >= 2, 'verification popup listed');
  const popup = await page.evaluate(async (url) => (await (await fetch(url)).json()).tabs.find((tab) => tab.url.endsWith('/popup')), `${origin}/api/remote-connect/${session.id}/state`);
  await page.getByLabel('Browser tab').selectOption(popup.id);
  await waitFor(async () => {
    const state = await page.evaluate(async (url) => (await fetch(url)).json(), `${origin}/api/remote-connect/${session.id}/state`);
    return state.targetId === popup.id && await page.locator('img').count() === 1;
  }, 'popup selected');
  await click(80, 120);
  await waitFor(async () => {
    const state = await page.evaluate(async (url) => (await fetch(url)).json(), `${origin}/api/remote-connect/${session.id}/state`);
    return state.targetId === targetId;
  }, 'automatic return when the popup closes');
  await click(170, 170);
  await page.keyboard.type('remote-test@example.com');
  await page.keyboard.press('Tab');
  // insertText exercises mobile/IME input including a non-ASCII character.
  await page.keyboard.insertText('synthetic-Påss!23');
  await page.keyboard.press('Enter');
  await waitFor(async () => {
    const state = await page.evaluate(async (url) => (await fetch(url)).json(), `${origin}/api/remote-connect/${session.id}/state`);
    return state.tabs.some((tab) => tab.url.endsWith('/account'));
  }, 'typing and submitting the remote login form');
  await page.reload();
  await page.getByRole('button', { name: 'Done — return control' }).waitFor();
  await page.getByAltText('Live remote browser.', { exact: false }).waitFor();
  mkdirSync(path.join(process.cwd(), 'artifacts/remote-connect'), { recursive: true });
  await page.screenshot({ path: path.join(process.cwd(), 'artifacts/remote-connect/signed-in.png') });
  await page.getByRole('button', { name: 'Done — return control' }).click();
  await page.getByRole('heading', { name: 'Control returned' }).waitFor();
  assert.equal((await page.request.get(`${origin}/api/remote-connect/${session.id}/frame`)).status(), 401);
  const status = await fetch(`${origin}/api/remote-connect/sessions/${session.id}`, { headers: { Authorization: `Bearer ${ownerKey}`, 'x-remote-tenant': tenant } });
  assert.equal((await status.json()).status, 'completed');
  const snapshot = docker('exec', container, 'openclaw', 'browser', '--browser-profile', 'openclaw', 'snapshot');
  assert.match(snapshot, /Signed in successfully/);
  assert.ok(!requests.some((url) => /google-analytics|googletagmanager|\/api\/replay|\/api\/log/.test(url)), 'No analytics or recording on the login page');
  console.log('PASS: real pixels, wrong code, single-use code, cookie protection, CSRF, popup switching/auto-close, typing, Unicode password, submit, reload, Done, and OpenClaw sees the authenticated page after disconnect.');
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    mkdirSync(path.join(process.cwd(), 'artifacts/remote-connect'), { recursive: true });
    await page.screenshot({ path: path.join(process.cwd(), 'artifacts/remote-connect/failure.png') }).catch(() => {});
  }
  try { console.error(docker('logs', '--tail', '20', container)); } catch {}
  throw error;
} finally {
  await browser?.close();
  if (web?.pid) { try { process.kill(-web.pid, 'SIGTERM'); } catch {} }
  if (broker) await new Promise((resolve) => broker.close(resolve));
  if (!process.env.REMOTE_CONNECT_KEEP_TEST) {
    try { docker('rm', '-f', container); } catch {}
    rmSync(scratch, { recursive: true, force: true });
  } else console.log(`Test container retained: ${container}, scratch: ${scratch}`);
}
