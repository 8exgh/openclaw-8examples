// Runs INSIDE the selected tenant via docker exec. Only pixels and the small
// input vocabulary below cross stdio. Never print page contents or input.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';

const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const config = JSON.parse(readFileSync('/home/node/.openclaw/openclaw.json', 'utf8'));
const profile = config.browser?.profiles?.openclaw;
const cdp = new URL(profile?.cdpUrl || `http://127.0.0.1:${profile?.cdpPort || 18800}`);
// No caller-supplied hosts, URLs, containers, JavaScript, or CDP commands.
if (!['localhost', '127.0.0.1', '[::1]'].includes(cdp.hostname) || cdp.protocol !== 'http:') {
  throw new Error('Remote login requires the local managed openclaw browser profile');
}
let socket;
let targetId;
let nextId = 0;
const pending = new Map();
const history = [];

function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Browser timed out')); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function tabs() {
  const response = await fetch(new URL('/json/list', cdp), { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Browser unavailable');
  return (await response.json()).filter((tab) => tab.type === 'page' && tab.webSocketDebuggerUrl);
}

async function select(id) {
  const pages = await tabs();
  const selected = id ? pages.find((page) => page.id === id) : pages.length === 1 ? pages[0] : undefined;
  if (!selected) throw new Error(id ? 'Browser tab is no longer available' : 'Choose a targetId from openclaw browser tabs --json');
  const url = new URL(selected.webSocketDebuggerUrl);
  if (url.hostname !== cdp.hostname || url.port !== cdp.port || url.protocol !== 'ws:') throw new Error('Invalid browser endpoint');
  socket?.close();
  socket = new WebSocket(url);
  const current = socket;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Browser connection timed out')), 5000);
    current.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    current.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Browser connection failed')); }, { once: true });
  });
  current.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(new Error('Browser command failed'));
    else request.resolve(message.result);
  });
  current.addEventListener('close', () => {
    if (current !== socket) return;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Browser disconnected'));
    }
    pending.clear();
  });
  targetId = selected.id;
  history.push(targetId);
  await command('Page.bringToFront');
  return { targetId };
}

async function handle(action, data) {
  if (action === 'select') return select(data.targetId);
  // OAuth popups commonly close themselves after login. Return to the prior
  // surviving tab without ending the owner's remote connection.
  if (socket && socket.readyState !== WebSocket.OPEN) {
    const pages = await tabs();
    const previous = history.slice().reverse().find((id) => pages.some((page) => page.id === id));
    await select(previous || pages[0]?.id);
  }
  if (action === 'tabs') return { targetId, tabs: (await tabs()).map(({ id, title, url }) => ({ id, title, url })) };
  if (action === 'frame') {
    // A newly opened OAuth popup can background the selected page. Headful
    // Chromium may then wait indefinitely for a frame from that page.
    await command('Page.bringToFront');
    const [shot, metrics] = await Promise.all([
      command('Page.captureScreenshot', { format: 'jpeg', quality: 70, captureBeyondViewport: false }),
      command('Page.getLayoutMetrics'),
    ]);
    const viewport = metrics.cssVisualViewport || metrics.visualViewport;
    return { image: shot.data, width: viewport.clientWidth, height: viewport.clientHeight, targetId };
  }
  if (action === 'input') {
    if (data.kind === 'text') await command('Input.insertText', { text: data.text });
    else if (data.kind === 'key') {
      const params = { key: data.key, code: data.code, windowsVirtualKeyCode: data.keyCode, modifiers: data.modifiers };
      await command('Input.dispatchKeyEvent', { ...params, type: data.key === 'Enter' ? 'keyDown' : 'rawKeyDown',
        ...(data.key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
      await command('Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
    } else if (data.kind === 'click') {
      const params = { x: data.x, y: data.y, button: 'left', clickCount: data.clickCount || 1 };
      await command('Input.dispatchMouseEvent', { ...params, type: 'mousePressed' });
      await command('Input.dispatchMouseEvent', { ...params, type: 'mouseReleased' });
    } else if (data.kind === 'scroll') {
      await command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: data.x, y: data.y, deltaX: data.deltaX, deltaY: data.deltaY });
    }
    return { ok: true };
  }
  throw new Error('Unsupported action');
}

// Serial input preserves keystroke/click order. stdin close or broker failure
// ends only this attachment, never Chromium (its profile/cookies stay intact).
let queue = Promise.resolve();
createInterface({ input: process.stdin }).on('line', (line) => {
  queue = queue.then(async () => {
    let request;
    try {
      request = JSON.parse(line);
      emit({ id: request.id, result: await handle(request.action, request.data || {}) });
    } catch {
      emit({ id: request?.id, error: 'Browser unavailable. Ask your Claw to open the login tab and create a new connection.' });
    }
  });
}).on('close', () => process.exit(0));
setTimeout(() => process.exit(0), 16 * 60 * 1000).unref();
