// Real container PTY -> private broker -> production website -> Chromium/WebKit.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { createTerminalBroker } from './broker.mjs';
import { terminalTransport } from './transport.mjs';
import { testHttps } from '../remote-connect/test-https.mjs';

const site = path.resolve(process.env.REMOTE_TERMINAL_SITE_DIR || '../8examples');
const { chromium, webkit, devices, expect } = createRequire(path.join(site, 'package.json'))('@playwright/test');
const scratch = mkdtempSync(path.join(tmpdir(), 'terminal-e2e-'));
const tenant = `terminal-test-${randomBytes(4).toString('hex')}`, container = `openclaw-${tenant}`;
const token = randomBytes(32).toString('hex'), key = randomBytes(32).toString('hex');
const origin = 'http://127.0.0.1:3119', publicOrigin = 'https://127.0.0.1:3120';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
let broker, web, tls, browser;
const waitFor = async check => { for (let n = 0; n < 120; n++) { try { if (await check()) return; } catch {} await new Promise(resolve => setTimeout(resolve, 250)); } throw new Error('E2E wait timed out'); };
try {
  docker('run', '-d', '--name', container, '--init', '--memory=512m', '--entrypoint', '/bin/bash',
    process.env.REMOTE_TERMINAL_TEST_IMAGE || 'ghcr.io/openclaw/openclaw:2026.8.1-browser', '-c', 'mkdir -p /home/node/.openclaw/workspace && exec sleep infinity');
  broker = createTerminalBroker({ serviceToken: token, tenantCredential: id => id === tenant ? key : undefined, createTransport: terminalTransport, publicOrigin: origin });
  await new Promise(resolve => broker.listen(18884, '127.0.0.1', resolve));
  web = spawn('node', ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3119'], {
    cwd: site, stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, E2E_TEST_BUILD: '1', CLAW_TEST_MODE: '1', DB_PATH: path.join(scratch, 'events.db'), REPLAY_DB_PATH: path.join(scratch, 'replays.db'),
      REMOTE_CONNECT_SERVICE_TOKEN: token, REMOTE_TERMINAL_BROKER_URL: 'http://127.0.0.1:18884', REMOTE_CONNECT_PUBLIC_ORIGIN: origin },
  });
  await waitFor(async () => (await fetch(origin + '/remote-terminal/00000000-0000-4000-8000-000000000000')).ok);
  tls = await testHttps(scratch, origin, publicOrigin);
  for (const mode of ['desktop', 'ipad']) {
    const create = await fetch(origin + '/api/remote-terminal/sessions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'X-Remote-Tenant': tenant, 'Content-Type': 'application/json' }, body: JSON.stringify({ tenant }) });
    assert.equal(create.status, 200); const session = await create.json();
    browser = await (mode === 'ipad' ? webkit : chromium).launch({ headless: true });
    const context = await browser.newContext({ ...(mode === 'ipad' ? devices['iPad Pro 11 landscape'] : { viewport: { width: 1440, height: 1000 } }), ignoreHTTPSErrors: true });
    const page = await context.newPage(), requests = [];
    page.on('request', req => requests.push(req.url()));
    const pageResponse = await page.goto(session.url.replace(origin, publicOrigin));
    assert.equal(pageResponse.headers()['referrer-policy'], 'no-referrer');
    await page.getByLabel('Connection code', { exact: true }).fill(session.code === '000000' ? '000001' : '000000');
    await page.getByRole('button', { name: 'Connect to terminal', exact: true }).click();
    await expect(page.locator('main').getByRole('alert')).toContainText('incorrect');
    await page.getByLabel('Connection code', { exact: true }).fill(session.code);
    await page.getByRole('button', { name: 'Connect to terminal', exact: true }).click();
    await page.getByLabel('Terminal input', { exact: true }).waitFor();
    const screen = () => page.locator('.xterm-rows').innerText();
    await expect.poll(screen).toContain('/workspace');
    const cookie = (await context.cookies()).find(c => c.name.startsWith('__Secure-terminal_'));
    assert(cookie?.httpOnly && cookie.secure && cookie.sameSite === 'Strict');
    const api = `${publicOrigin}/api/remote-terminal/${session.id}`;
    assert.equal((await page.request.post(api + '/input', { headers: { Origin: 'https://untrusted.example' }, data: { sequence: 1, data: 'eA==' } })).status(), 403);
    const stranger = await browser.newContext({ ignoreHTTPSErrors: true });
    assert.equal((await stranger.request.get(api + '/output')).status(), 401);
    assert.equal((await stranger.request.post(api + '/unlock', { headers: { Origin: publicOrigin }, data: { code: session.code } })).status(), 410);
    await stranger.close();
    await page.getByRole('button', { name: 'Keyboard', exact: true }).click();
    await page.keyboard.type("printf 'E2E:%s\\n' \"$(id -un)\"; test -t 0 && echo REAL_TTY");
    await page.keyboard.press('Enter');
    await expect.poll(screen).toContain('E2E:node');
    await expect.poll(screen).toContain('REAL_TTY');
    // Exercise editing, Unicode, touch key controls and physical Ctrl+C.
    await page.keyboard.type("printf 'UNICODE:"); await page.keyboard.insertText('å猫'); await page.keyboard.type("\\n'"); await page.keyboard.press('Enter');
    await expect.poll(screen).toContain('UNICODE:å猫');
    await page.keyboard.type('sleep 60'); await page.keyboard.press('Enter');
    if (mode === 'ipad') await page.getByRole('button', { name: 'Ctrl+C', exact: true }).tap(); else await page.keyboard.press('Control+c');
    await page.keyboard.type(`printf 'saved-${mode}' > terminal-proof-${mode}.txt`); await page.keyboard.press('Enter');
    await waitFor(() => docker('exec', container, 'cat', `/home/node/.openclaw/workspace/terminal-proof-${mode}.txt`) === `saved-${mode}`);
    // Network failure after a completed POST: prove no duplicate execution.
    await page.keyboard.type(`printf 'once\\n' >> terminal-once-${mode}.txt`);
    await expect.poll(screen).toContain(`terminal-once-${mode}.txt`);
    let dropped = false;
    await page.route('**/api/remote-terminal/*/input', async route => {
      if (!dropped) { dropped = true; await route.fetch(); await route.abort(); } else await route.continue();
    });
    await page.keyboard.press('Enter');
    await expect(page.locator('main').getByRole('status')).toContainText('not sent again');
    await waitFor(() => docker('exec', container, 'cat', `/home/node/.openclaw/workspace/terminal-once-${mode}.txt`) === 'once\n');
    await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
    await page.unroute('**/api/remote-terminal/*/input');
    await page.reload(); await page.getByLabel('Terminal input', { exact: true }).waitFor();
    await expect.poll(screen).toContain('E2E:node');
    if (mode === 'desktop') { await page.setViewportSize({ width: 390, height: 844 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await page.setViewportSize({ width: 1440, height: 1000 }); }
    mkdirSync('artifacts/remote-terminal', { recursive: true }); await page.screenshot({ path: `artifacts/remote-terminal/${mode}.png` });
    await page.getByRole('button', { name: 'End terminal', exact: true }).click();
    await page.getByRole('heading', { name: 'Terminal closed', exact: true }).waitFor();
    assert.equal((await page.request.get(api + '/output')).status(), 401);
    assert.equal(docker('exec', container, 'cat', `/home/node/.openclaw/workspace/terminal-proof-${mode}.txt`), `saved-${mode}`);
    assert(!requests.some(url => /google-analytics|googletagmanager|\/api\/(?:replay|log)(?:\?|$)/.test(url)), 'Private terminal excludes analytics and recording');
    await browser.close(); browser = undefined;
    console.log(`PASS ${mode}: real container PTY, OTP/cookies, CSRF, keyboard/Unicode/Ctrl+C, resize, reconnect, no duplicate input, saved file and clean completion.`);
  }
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) { console.log((await page.locator("main").innerText()).slice(-5000)); await page.screenshot({path:"/tmp/terminal-e2e-failure.png"}); }
  throw error;
} finally {
  await browser?.close();
  broker?.shutdown(); broker?.closeAllConnections(); tls?.closeAllConnections(); tls?.close();
  if (web && web.exitCode === null) { web.kill('SIGTERM'); await new Promise(resolve => web.once('exit', resolve)); }
  try { docker('rm', '-f', container); } catch {}
  rmSync(scratch, { recursive: true, force: true });
}
