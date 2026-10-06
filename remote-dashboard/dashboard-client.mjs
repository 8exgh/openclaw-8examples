import { createBrowserClient } from '../remote-connect/browser-client.mjs';

// The real dashboard runs in an incognito context inside this tenant. Only
// pixels and input cross the website boundary; its permanent token never does.
export async function createDashboardClient(cdp, gateway, token, { fetchImpl = fetch, WebSocketImpl = WebSocket } = {}) {
  let phase = 'endpoint';
  const failure = () => Object.assign(new Error('Dashboard unavailable'), { code: 'dashboard_' + phase });
  const local = url => ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!local(cdp) || cdp.protocol !== 'http:' || !local(gateway) || gateway.protocol !== 'http:') throw failure();
  let socket, browser, contextId, targetId, closed = false, nextId = 0, authenticated = false;
  const gatewaySockets = new Set();
  const pending = new Map();
  function close() {
    if (closed) return;
    closed = true;
    browser?.close();
    // Chromium disposes the entire incognito context when this CDP connection
    // detaches, including on broker crash, Docker exec exit, or gateway outage.
    socket?.close();
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(failure()); }
    pending.clear();
  }
  function command(method, params = {}, sessionId) {
    if (closed || socket?.readyState !== WebSocketImpl.OPEN) return Promise.reject(failure());
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(failure()); }, 5000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  try {
    const response = await fetchImpl(new URL('/json/version', cdp), { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw failure();
    const endpoint = new URL((await response.json()).webSocketDebuggerUrl);
    if (!local(endpoint) || endpoint.protocol !== 'ws:' || endpoint.port !== cdp.port) throw failure();
    socket = new WebSocketImpl(endpoint);
    socket.addEventListener('message', ({ data }) => {
      let message; try { message = JSON.parse(data); } catch { return; }
      if (message.method === 'Network.webSocketCreated') {
        try { const url = new URL(message.params.url); if (url.protocol === 'ws:' && url.host === gateway.host) gatewaySockets.add(message.params.requestId); } catch { /* unrelated URL */ }
      }
      if (message.method === 'Network.webSocketFrameReceived' && gatewaySockets.has(message.params.requestId)) {
        try { const reply = JSON.parse(message.params.response.payloadData); if (reply.type === 'res' && reply.ok === true && reply.payload?.type === 'hello-ok') authenticated = true; } catch { /* unrelated frame */ }
      }
      const p = pending.get(message.id); if (!p) return;
      pending.delete(message.id); clearTimeout(p.timer);
      if (message.error) p.reject(failure()); else p.resolve(message.result);
    });
    socket.addEventListener('close', close);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(failure()), 3000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(failure()); }, { once: true });
    });
    phase = 'context';
    ({ browserContextId: contextId } = await command('Target.createBrowserContext', { disposeOnDetach: true }));
    phase = 'target';
    ({ targetId } = await command('Target.createTarget', { url: 'about:blank', browserContextId: contextId }));
    phase = 'attach';
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
    await command('Network.enable', {}, sessionId);
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    const dashboard = new URL(gateway);
    dashboard.hash = new URLSearchParams({ token }).toString();
    phase = 'navigate';
    await command('Page.navigate', { url: dashboard.href }, sessionId);
    // Do not issue a handoff until the actual UI has authenticated successfully.
    phase = 'authentication';
    for (let i = 0; i < 50 && !authenticated; i++) await new Promise(resolve => setTimeout(resolve, 200));
    if (!authenticated) throw failure();
    phase = 'viewer';
    browser = createBrowserClient(cdp, {
      WebSocketImpl,
      async fetchImpl(url, options) {
        // Every enumeration, selection, and reconnect is confined to this
        // context. Never fall back to the owner's ordinary managed-browser tabs.
        const response = await fetchImpl(url, options);
        const { targetInfos } = await command('Target.getTargets');
        const owned = new Set(targetInfos.filter(t => t.browserContextId === contextId).map(t => t.targetId));
        return { ok: response.ok, json: async () => (await response.json()).filter(t => owned.has(t.id)) };
      },
    });
    await browser.handle('select', { targetId });
    return {
      close,
      get closed() { return closed; },
      async handle(action, data = {}) {
        if (closed) throw failure();
        if (action === 'select' && !data.targetId) data = { ...data, targetId };
        const result = await browser.handle(action, data);
        if (action === 'tabs') {
          // Never publish the local gateway address or its token fragment.
          return { targetId: result.targetId, tabs: result.tabs.map(t => ({ id: t.id, title: 'OpenClaw dashboard', url: 'about:blank' })) };
        }
        return result;
      },
    };
  } catch { close(); throw failure(); }
}
