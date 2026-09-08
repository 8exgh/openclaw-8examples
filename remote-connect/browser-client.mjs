// Trusted CDP client shared by the injected bridge and isolated regressions.
// Errors contain fixed categories, never URLs, page text, or entered data.
export function createBrowserClient(cdp, { fetchImpl = fetch, WebSocketImpl = WebSocket, commandTimeoutMs = 4000 } = {}) {
  const failure = code => Object.assign(new Error('Browser connection interrupted'), { code, retryable: true });
  let socket, targetId, nextId = 0, reconnect = false;
  const history = [];
  const pending = new Map();
  function close() {
    const previous = socket;
    socket = undefined;
    previous?.close();
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(failure('cdp_disconnected'));
    }
    pending.clear();
  }
  function command(method, params = {}) {
    if (socket?.readyState !== WebSocketImpl.OPEN) return Promise.reject(failure('cdp_disconnected'));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(failure('cdp_timeout')); }, commandTimeoutMs);
      pending.set(id, { resolve, reject, timer, socket });
      try { socket.send(JSON.stringify({ id, method, params })); }
      catch { clearTimeout(timer); pending.delete(id); reject(failure('cdp_disconnected')); }
    });
  }
  async function tabs() {
    try {
      const response = await fetchImpl(new URL('/json/list', cdp), { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw failure('browser_unreachable');
      return (await response.json()).filter(tab => tab.type === 'page' && tab.webSocketDebuggerUrl);
    } catch { throw failure('browser_unreachable'); }
  }
  async function attach(selected) {
    if (!selected) throw failure('tab_missing');
    const url = new URL(selected.webSocketDebuggerUrl);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.port !== cdp.port || url.protocol !== 'ws:') throw failure('invalid_endpoint');
    close();
    socket = new WebSocketImpl(url);
    const current = socket;
    current.addEventListener('message', ({ data }) => {
      let message; try { message = JSON.parse(data); } catch { return; }
      const request = pending.get(message.id);
      if (!request || request.socket !== current) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error) request.reject(failure('cdp_command_failed'));
      else request.resolve(message.result);
    });
    current.addEventListener('close', () => { if (current === socket) close(); });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { current.close(); reject(failure('cdp_connect_timeout')); }, 3000);
      current.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      current.addEventListener('error', () => { clearTimeout(timeout); reject(failure('cdp_connect_failed')); }, { once: true });
    });
    targetId = selected.id;
    if (history.at(-1) !== targetId) history.push(targetId);
    if (history.length > 16) history.shift();
    reconnect = false;
    await command('Page.bringToFront');
    return { targetId };
  }
  async function select(id, allowFallback = false) {
    const pages = await tabs();
    return attach((id && pages.find(page => page.id === id)) || ((!id && pages.length === 1) || allowFallback ? pages[0] : undefined));
  }
  async function recover() {
    const pages = await tabs();
    const previous = history.slice().reverse().find(id => pages.some(page => page.id === id));
    return attach(pages.find(page => page.id === (previous || targetId)) || pages[0]);
  }
  async function handle(action, data = {}) {
    try {
      if (action === 'select') return await select(data.targetId, data.allowFallback === true);
      if (reconnect || socket?.readyState !== WebSocketImpl.OPEN) {
        await recover();
        // Wait for a restored frame before queued input can affect another tab.
        if (action === 'input') throw failure('input_not_sent');
      }
      if (action === 'tabs') return { targetId, tabs: (await tabs()).map(({ id, title, url }) => ({ id, title, url })) };
      if (action === 'frame') {
        await command('Page.bringToFront');
        const [shot, metrics, windowSize] = await Promise.all([
          command('Page.captureScreenshot', { format: 'jpeg', quality: 70, captureBeyondViewport: false }),
          command('Page.getLayoutMetrics'),
          // Screenshots include the scrollbars. VisualViewport.clientWidth /
          // clientHeight exclude them, shifting clicks toward the top left.
          command('Runtime.evaluate', { expression: '({width:innerWidth,height:innerHeight})', returnByValue: true }),
        ]);
        const viewport = metrics.cssVisualViewport || metrics.visualViewport;
        const size = windowSize?.result?.value;
        const scale = viewport?.scale || 1;
        const width = size?.width / scale, height = size?.height / scale;
        if (!shot?.data || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 16384 || height > 16384) throw failure('frame_not_ready');
        return { image: shot.data, width, height, targetId };
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
      throw failure('unsupported_action');
    } catch (error) {
      // Only future reads retry. Input may already have reached Chromium.
      reconnect = true;
      close();
      throw error?.retryable ? error : failure('browser_interrupted');
    }
  }
  return { handle, close };
}
