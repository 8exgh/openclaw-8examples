import { createServer } from 'node:http';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest();
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(hash(a), hash(b));
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const tenantPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
class Rejected extends Error { constructor(status, message) { super(message); this.status = status; } }
const reject = (status, message) => { throw new Rejected(status, message); };
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 16384) reject(413, 'Request too large'); chunks.push(chunk); }
  try { const data = JSON.parse(Buffer.concat(chunks).toString() || '{}'); if (!data || Array.isArray(data) || typeof data !== 'object') throw 0; return data; }
  catch { reject(400, 'Invalid request'); }
}

export function createTerminalBroker({ serviceToken, tenantCredential, createTransport, publicOrigin = 'https://8examples.com',
  now = Date.now, ttlMs = 15 * 60_000, idleMs = 3 * 60_000, onStatus = () => {}, allowAdmin = () => false }) {
  if (!serviceToken || serviceToken.length < 32) throw new Error('A service credential of at least 32 characters is required');
  const sessions = new Map(), creating = new Set(), rates = new Map();
  const active = s => s.status === 'waiting' || s.status === 'connected';
  const state = s => ({ id: s.id, tenant: s.tenant, status: s.status, mode: s.mode, shellGeneration: s.shellGeneration, adminAvailable: allowAdmin(s.tenant), expiresAt: new Date(s.expires).toISOString(), lastInputSequence: s.lastInput });
  const status = s => { try { onStatus(s.tenant, state(s)); } catch { /* advisory status only */ } };
  function end(s, reason) {
    if (!active(s)) return;
    s.status = reason; s.codeHash = undefined; s.viewer = undefined; s.transport.close(); status(s);
  }
  function sweep() {
    for (const [id, s] of sessions) {
      if (active(s) && !equal(s.ownerKey, tenantCredential(s.tenant))) end(s, 'revoked');
      if (active(s) && (now() >= s.expires || (s.status === 'connected' && now() - s.lastSeen >= idleMs))) end(s, 'expired');
      if (now() >= s.expires + 3600_000) sessions.delete(id);
    }
    for (const [tenant, rate] of rates) if (now() - rate.start >= 600_000) rates.delete(tenant);
  }
  const timer = setInterval(sweep, 1000); timer.unref();
  function owner(req, tenant) {
    if (typeof tenant !== 'string' || !tenantPattern.test(tenant) || !equal(req.headers['x-remote-tenant-key'], tenantCredential(tenant))) reject(401, 'Terminal access is not enabled for this Claw.');
    return tenantCredential(tenant);
  }
  function assigned(s) {
    if (!equal(s.ownerKey, tenantCredential(s.tenant))) { end(s, 'revoked'); reject(410, 'This terminal connection has ended.'); }
  }
  async function route(req) {
    if (!equal(req.headers.authorization, `Bearer ${serviceToken}`)) reject(401, 'Unauthorized');
    const url = new URL(req.url, 'http://broker'), path = url.pathname;
    if (req.method === 'GET' && path === '/health') return { ok: true };
    sweep();
    if (req.method === 'POST' && ['/sessions', '/account/sessions'].includes(path)) {
      const data = await body(req), tenant = data.tenant;
      // /account/sessions is called only by the authenticated website backend
      // after it verifies the signed-in account's current ownership.
      const ownerKey = path === '/account/sessions' && typeof tenant === 'string' && tenantPattern.test(tenant) ? tenantCredential(tenant) : owner(req, tenant);
      if (!ownerKey) reject(403, 'Terminal access is not enabled for this Claw.');
      if (Object.keys(data).some(key => key !== 'tenant')) reject(400, 'A terminal opens only the Claw’s default workspace shell.');
      if (creating.has(tenant)) reject(409, 'A terminal is already being prepared.');
      if ([...sessions.values()].filter(active).length + creating.size >= 100) reject(503, 'Terminal connections are busy.');
      const rate = rates.get(tenant) || { start: now(), count: 0 }; rates.set(tenant, rate);
      if (++rate.count > 10) reject(429, 'Too many connection requests. Try again later.');
      creating.add(tenant);
      let transport;
      try {
        transport = createTransport(tenant); await transport.ready;
        if (!equal(ownerKey, tenantCredential(tenant))) reject(401, 'Terminal access changed while connecting.');
        for (const s of sessions.values()) if (s.tenant === tenant) end(s, 'replaced');
        const id = randomUUID(), code = String(randomInt(0, 1_000_000)).padStart(6, '0');
        const s = { id, tenant, ownerKey, transport, mode: 'node', shellGeneration: 0, codeHash: hash(id + code), attempts: 0, status: 'waiting',
          expires: now() + ttlMs, lastSeen: now(), lastInput: 0, inputTail: Promise.resolve() };
        sessions.set(id, s); status(s);
        return { ...state(s), url: `${publicOrigin}/remote-terminal/${id}`, code };
      } catch (error) { transport?.close(); throw error; }
      finally { creating.delete(tenant); }
    }
    const ownerMatch = path.match(new RegExp(`^/sessions/(${uuid})$`));
    if (ownerMatch && ['GET', 'DELETE'].includes(req.method)) {
      const tenant = req.headers['x-remote-tenant']; owner(req, tenant);
      const s = sessions.get(ownerMatch[1]); if (!s || s.tenant !== tenant) reject(404, 'Connection not found');
      if (req.method === 'DELETE') end(s, 'revoked');
      return state(s);
    }
    const match = path.match(new RegExp(`^/(${uuid})/(unlock|state|output|input|resize|complete|shell)$`));
    if (!match) reject(404, 'Connection not found');
    const [, id, action] = match, s = sessions.get(id);
    const method = ['state', 'output'].includes(action) ? 'GET' : 'POST';
    if (req.method !== method) reject(405, 'Method not allowed');
    if (!s || !active(s)) reject(410, 'This terminal connection has ended. Ask your Claw for a new link.');
    assigned(s);
    if (action === 'unlock') {
      const data = await body(req);
      // Check again AFTER reading the body: concurrent redemption must have one winner.
      sweep(); assigned(s);
      if (s.status !== 'waiting') reject(410, 'This code has already been used or expired. Ask your Claw for a new link.');
      if (typeof data.code !== 'string' || !/^\d{6}$/.test(data.code) || !timingSafeEqual(hash(id + data.code), s.codeHash)) {
        if (++s.attempts >= 5) end(s, 'locked');
        reject(401, s.status === 'locked' ? 'Too many incorrect codes. Ask your Claw for a new link.' : 'That code is incorrect.');
      }
      s.codeHash = undefined; s.viewer = randomBytes(32).toString('hex'); s.status = 'connected'; s.lastSeen = now(); status(s);
      return { ...state(s), viewerToken: s.viewer };
    }
    if (s.status !== 'connected' || !equal(req.headers['x-remote-viewer'], s.viewer)) reject(401, 'Enter the six-digit code from your Claw.');
    s.lastSeen = now();
    if (action === 'complete') { end(s, 'completed'); return state(s); }
    if (action === 'state') return { ...state(s), running: s.transport.read().running };
    if (action === 'output') {
      const raw = url.searchParams.get('after') || '0';
      if (!/^\d{1,15}$/.test(raw) || !Number.isSafeInteger(Number(raw))) reject(400, 'Invalid output cursor');
      return { ...state(s), ...s.transport.read(Number(raw)) };
    }
    const data = await body(req);
    sweep(); assigned(s); if (s.status !== 'connected') reject(410, 'This terminal connection has ended.');
    if (action === 'shell') {
      if (!['node', 'root'].includes(data.mode) || Object.keys(data).some(key => key !== 'mode')) reject(400, 'Choose Claw user or administrator.');
      if (data.mode === 'root' && !allowAdmin(s.tenant)) reject(403, 'Administrator access is not enabled for this Claw.');
      if (s.changing) reject(409, 'A shell is already being opened.');
      s.changing = true;
      let next;
      try {
        await s.inputTail;
        next = createTransport(s.tenant, data.mode); await next.ready;
        sweep(); assigned(s);
        if (s.status !== 'connected') reject(410, 'This terminal connection has ended.');
        s.transport.close(); s.transport = next; next = undefined;
        s.mode = data.mode; s.lastInput = 0; s.shellGeneration++; status(s);
        return state(s);
      } finally { next?.close(); s.changing = false; }
    }
    if (s.changing) reject(409, 'A shell is being opened.');
    // Old tabs or delayed requests must never type into a replacement shell,
    // especially when it runs as root. Legacy clients work only in shell zero.
    if ((data.shellGeneration ?? 0) !== s.shellGeneration) reject(409, 'The shell changed. Reload this terminal before typing.');
    if (action === 'resize') {
      if (!Number.isInteger(data.cols) || data.cols < 2 || data.cols > 500 || !Number.isInteger(data.rows) || data.rows < 2 || data.rows > 200) reject(400, 'Invalid terminal size');
      await s.transport.request('resize', { cols: data.cols, rows: data.rows }); return { ok: true };
    }
    if (!Number.isSafeInteger(data.sequence) || data.sequence < 1 || typeof data.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.data) || !data.data.length || Buffer.byteLength(data.data, 'base64') > 4096) reject(400, 'Invalid terminal input');
    // Serialize and deduplicate across requests, including overlapping retries.
    const input = s.inputTail.then(async () => {
      sweep(); assigned(s); if (s.status !== 'connected') reject(410, 'This terminal connection has ended.');
      if (data.sequence === s.lastInput) return { sequence: s.lastInput };
      if (data.sequence !== s.lastInput + 1) reject(409, 'Input order changed. Reconnect before typing again.');
      try { await s.transport.request('input', { data: data.data }); }
      catch { end(s, 'disconnected'); reject(410, 'The terminal stopped responding. Input was not retried. Ask your Claw for a new connection.'); }
      s.lastInput = data.sequence; return { sequence: s.lastInput };
    });
    s.inputTail = input.catch(() => {}); return input;
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private'); res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try { res.end(JSON.stringify(await route(req))); }
    catch (error) { res.statusCode = error instanceof Rejected ? error.status : 503;
      res.end(JSON.stringify({ error: error instanceof Rejected ? error.message : 'Terminal unavailable. Ask your Claw to try again.' })); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.on('close', () => { clearInterval(timer); for (const s of sessions.values()) end(s, 'disconnected'); });
  server.shutdown = () => { for (const s of sessions.values()) end(s, 'disconnected'); server.close(); };
  return server;
}
