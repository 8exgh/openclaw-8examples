import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserClient } from './browser-client.mjs';

function fixture() {
  const pages = new Set(['main']);
  const sockets = [], commands = [];
  let behavior = () => undefined;
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    constructor(url) {
      super(); this.target = new URL(url).pathname.slice(1); sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
    send(raw) {
      const message = JSON.parse(raw);
      commands.push({ ...message, target: this.target });
      const special = behavior(message, this);
      if (special === 'drop') return;
      const result = message.method === 'Page.captureScreenshot' ? { data: 'jpeg' }
        : message.method === 'Page.getLayoutMetrics' ? { cssVisualViewport: { clientWidth: 785, clientHeight: 585, scale: 1 } }
        : message.method === 'Runtime.evaluate' ? { result: { value: { width: 800, height: 600 } } } : {};
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: message.id, ...(special || { result }) }) })));
    }
  }
  const client = createBrowserClient(new URL('http://127.0.0.1:18800'), {
    commandTimeoutMs: 20, WebSocketImpl: Socket,
    fetchImpl: async () => ({ ok: true, json: async () => [...pages].map(id => ({ id, type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:18800/${id}` })) }),
  });
  return { client, pages, sockets, commands, behave: value => { behavior = value; } };
}

test('a transient screenshot failure reattaches the surviving tab on the next frame', async t => {
  const f = fixture(); t.after(f.client.close);
  await f.client.handle('select', { targetId: 'main' });
  f.behave(({ method }) => method === 'Page.captureScreenshot' ? { error: { message: 'sensitive page details must not escape' } } : undefined);
  await assert.rejects(f.client.handle('frame'), error => error.code === 'cdp_command_failed' && !error.message.includes('sensitive'));
  f.behave(() => undefined);
  assert.equal((await f.client.handle('frame')).targetId, 'main');
  assert.equal(f.sockets.length, 2);
});

test('frame coordinates include both scrollbars and account for pinch zoom', async t => {
  const f = fixture(); t.after(f.client.close);
  await f.client.handle('select', { targetId: 'main' });
  assert.deepEqual(await f.client.handle('frame'), { image: 'jpeg', width: 800, height: 600, targetId: 'main' });
  f.behave(({ method }) => method === 'Page.getLayoutMetrics'
    ? { result: { cssVisualViewport: { clientWidth: 392.5, clientHeight: 292.5, scale: 2 } } } : undefined);
  assert.deepEqual(await f.client.handle('frame'), { image: 'jpeg', width: 400, height: 300, targetId: 'main' });
});

test('missing viewport dimensions cannot produce an input-ready frame', async t => {
  const f = fixture(); t.after(f.client.close);
  await f.client.handle('select', { targetId: 'main' });
  f.behave(({ method }) => method === 'Runtime.evaluate' ? { result: { exceptionDetails: {} } } : undefined);
  await assert.rejects(f.client.handle('frame'), { code: 'frame_not_ready' });
});

test('a timed-out screenshot recovers without waiting for a new login code', async t => {
  const f = fixture(); t.after(f.client.close);
  await f.client.handle('select', { targetId: 'main' });
  f.behave(({ method }) => method === 'Page.captureScreenshot' ? 'drop' : undefined);
  await assert.rejects(f.client.handle('frame'), { code: 'cdp_timeout' });
  f.behave(() => undefined);
  assert.equal((await f.client.handle('frame')).image, 'jpeg');
});

test('OAuth popup closure restores its opener and never replays uncertain input', async t => {
  const f = fixture(); t.after(f.client.close);
  await f.client.handle('select', { targetId: 'main' });
  f.pages.add('popup');
  await f.client.handle('select', { targetId: 'popup' });
  f.behave(({ method, params }, socket) => {
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') { f.pages.delete('popup'); socket.close(); return 'drop'; }
  });
  await assert.rejects(f.client.handle('input', { kind: 'click', x: 20, y: 20 }), { code: 'cdp_disconnected' });
  await assert.rejects(f.client.handle('input', { kind: 'text', text: 'queued synthetic input' }), { code: 'input_not_sent' });
  f.behave(() => undefined);
  assert.equal((await f.client.handle('frame')).targetId, 'main');
  assert.equal(f.commands.filter(c => c.method.startsWith('Input.') && c.target === 'main').length, 0);
  assert.equal(f.commands.filter(c => c.params.type === 'mousePressed').length, 1);
});

test('a dropped CDP socket reconnects even when the original target still exists', async t => {
  const f = fixture(); t.after(f.client.close);
  await f.client.handle('select', { targetId: 'main' });
  f.sockets[0].close();
  assert.equal((await f.client.handle('frame')).targetId, 'main');
  assert.equal(f.sockets.length, 2);
});
