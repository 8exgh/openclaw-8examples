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
// Use raw CDP identities for this disposable tab. CLI tab references/selection
// are session-scoped, and must never let verification close an owner's tab.
const browser = async (action, target = '') => {
  const command = action === 'navigate' ? { method: 'Page.navigate', params: { url: 'https://example.org' } }
    : action === 'prepare-pointer' ? { method: 'Runtime.evaluate', params: { returnByValue: true, expression: `(() => {
      document.documentElement.style.overflow = 'scroll';
      document.body.style.cssText = 'margin:0;width:1600px;height:1600px;max-width:none';
      document.body.innerHTML = '<button id="remote-pointer-test" style="position:absolute;left:700px;top:350px;width:6px;height:6px;padding:0;border:0;background:blue"></button>';
      const target = document.getElementById('remote-pointer-test');
      const field = document.createElement('input'); field.id = 'remote-keyboard-test'; document.body.append(field);
      target.onclick = () => { target.dataset.clicked = 'yes'; field.focus(); };
      const box = target.getBoundingClientRect();
      return { width: innerWidth / visualViewport.scale, height: innerHeight / visualViewport.scale, x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()` } }
    : action === 'keyboard-status' ? { method: 'Runtime.evaluate', params: { returnByValue: true, expression: "document.getElementById('remote-keyboard-test')?.value === 'synthetic-ipad-å'" } }
    : action === 'pointer-status' ? { method: 'Runtime.evaluate', params: { returnByValue: true, expression: "document.getElementById('remote-pointer-test')?.dataset.clicked === 'yes'" } }
    : undefined;
  const source = `
    import {readFileSync} from 'node:fs';
    const profile=JSON.parse(readFileSync('/home/node/.openclaw/openclaw.json','utf8')).browser?.profiles?.openclaw;
    const cdp=new URL(profile?.cdpUrl||'http://127.0.0.1:'+(profile?.cdpPort||18800));
    if(cdp.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(cdp.hostname)) throw new Error('Expected local managed browser');
    const action=process.argv[1],target=process.argv[2];
    if(target&&!/^[A-Za-z0-9-]{1,128}$/.test(target)) throw new Error('Invalid target');
    let result;
    if(action==='list') {
      const tabs=await(await fetch(new URL('/json/list',cdp))).json();
      result=tabs.filter(t=>t.type==='page').map(t=>t.id);
    } else if(action==='open') {
      const response=await fetch(new URL('/json/new?'+encodeURIComponent('https://example.com'),cdp),{method:'PUT'});
      if(!response.ok) throw new Error('Could not open test tab');
      result={id:(await response.json()).id};
    } else if(action==='close') {
      const response=await fetch(new URL('/json/close/'+target,cdp));
      if(!response.ok) throw new Error('Could not close test tab');
      result={ok:true};
    } else if(['navigate','prepare-pointer','pointer-status','keyboard-status'].includes(action)) {
      const command=${JSON.stringify(command)};
      const tabs=await(await fetch(new URL('/json/list',cdp))).json();
      const page=tabs.find(t=>t.id===target);
      if(!page) throw new Error('Missing test tab');
      const url=new URL(page.webSocketDebuggerUrl);
      if(url.protocol!=='ws:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.port!==cdp.port) throw new Error('Invalid CDP endpoint');
      const socket=new WebSocket(url);
      await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
      result=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Browser check timed out')),10000);
        socket.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.id===1){clearTimeout(timer);m.error?reject(new Error('Browser check failed')):resolve(command.method==='Runtime.evaluate'?m.result.result.value:{ok:true});}});
        socket.send(JSON.stringify({id:1,...command}));
      });
      socket.close();
    } else throw new Error('Unsupported check');
    console.log(JSON.stringify(result));
  `;
  try { return JSON.parse((await exec('docker', ['exec', container, 'node', '--input-type=module', '-e', source, action, target], { timeout: 20000 })).stdout); }
  catch { throw new Error(`Managed browser ${action} check failed`); }
};
const helper = async (action, targetId) => JSON.parse((await exec('docker', ['exec', '-w', '/home/node/.openclaw/workspace', container, 'node', 'remote-connect/session.mjs', action, ...(targetId ? [targetId] : [])], { timeout: 30000 })).stdout);
let tab;
let previousTabs = [];
let created = false;
try {
  try { previousTabs = await browser('list'); }
  catch { await cli('start'); previousTabs = await browser('list'); }
  const opened = await browser('open');
  assert.ok(opened.id && !previousTabs.includes(opened.id), 'Verification created a new disposable tab');
  tab = opened.id;
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
  // Modify only the disposable verification tab, never an owner's existing
  // page. A small target and both gutters expose the old coordinate drift.
  const target = await browser('prepare-pointer', tab);
  const frame = await fetch(base + '/frame', { headers, signal: AbortSignal.timeout(20000) });
  assert.equal(frame.status, 200, 'Live graphical browser frame over public HTTPS');
  const pixels = await frame.json();
  assert.ok(pixels.width > 0 && pixels.height > 0);
  assert.equal(Buffer.from(pixels.image, 'base64').readUInt16BE(0), 0xffd8, 'Real JPEG pixels');
  assert.ok(Math.abs(pixels.width - target.width) < 1 && Math.abs(pixels.height - target.height) < 1, 'Frame dimensions include the complete viewport and scrollbars');
  const clicked = await fetch(base + '/input', { method: 'POST', headers, body: JSON.stringify({ kind: 'click', x: target.x / target.width * pixels.width, y: target.y / target.height * pixels.height, clickCount: 1 }), signal: AbortSignal.timeout(20000) });
  assert.equal(clicked.status, 200, 'Public pointer input is acknowledged');
  assert.equal(await browser('pointer-status', tab), true, 'Public click hits the six-pixel target with both scrollbars present');
  for (const input of [{kind:'text',text:'synthetic-ipad-x'}, {kind:'key',key:'Backspace',code:'Backspace',keyCode:8,modifiers:0}, {kind:'text',text:'å'}]) {
    const typed = await fetch(base + '/input', { method:'POST', headers, body:JSON.stringify(input), signal:AbortSignal.timeout(20000) });
    assert.equal(typed.status, 200, 'Public keyboard input is acknowledged');
  }
  assert.equal(await browser('keyboard-status', tab), true, 'Click focus, keyboard editing, and Unicode text reach the same remote field');
  console.log('PASS: full viewport coordinates, six-pixel click target, field focus, typing, Backspace, and Unicode through public HTTPS.');
  // The original smoke check fetched one still image. Keep reading through a
  // real page navigation to exercise the browser lifecycle that login uses.
  const navigation = browser('navigate', tab).then(() => undefined, error => error);
  let healthyFrames = 0;
  for (let attempt=0; attempt<12; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 300));
    const response = await fetch(base + '/frame', { headers, signal: AbortSignal.timeout(35000) });
    if (response.status === 503) {
      assert.equal((await response.json()).retryable, true, 'Temporary browser failures keep this viewer connected');
      continue;
    }
    assert.equal(response.status, 200, 'Viewer survives real page navigation');
    assert.equal((await response.json()).targetId, tab, 'Same browser tab remains attached');
    healthyFrames++;
  }
  const navigationError = await navigation;
  if (navigationError) throw navigationError;
  assert.ok(healthyFrames > 0, 'Browser recovered with the original viewer cookie');
  const activeStatus = await helper('status');
  assert.equal(activeStatus.status, 'connected');
  const done = await fetch(base + '/complete', { method: 'POST', headers, body: '{}' });
  assert.equal(done.status, 200);
  assert.equal((await helper('status')).status, 'completed', 'Claw sees returned control');
  assert.equal((await fetch(base + '/frame', { headers })).status, 410, 'Closed connection rejects previous viewer cookie');
  console.log(`PASS ${tenant}: helper → public HTTPS page/code → actual browser pixels across navigation → same viewer cookie → Done → Claw status. No login credentials used.`);
} finally {
  if (created) await helper('revoke').catch(() => {});
  if (tab) {
    await browser('close', tab);
    const remaining = await browser('list');
    assert.ok(previousTabs.every(id => remaining.includes(id)), 'Verification preserves all pre-existing browser tabs');
    console.log('PASS: only the disposable verification tab was closed; every pre-existing tab remains.');
  }
}
