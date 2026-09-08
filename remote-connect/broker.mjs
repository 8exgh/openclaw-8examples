import { createServer } from 'node:http';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

const hash = (value) => createHash('sha256').update(value).digest();
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(hash(a), hash(b));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const tenantPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const targetPattern = /^[a-zA-Z0-9-]{1,128}$/;
class Rejected extends Error {
  constructor(status, message, retryable = false) { super(message); this.status = status; this.retryable = retryable; }
}
const reject = (status, message) => { throw new Rejected(status, message); };

async function body(req) {
  let value = '';
  for await (const chunk of req) {
    value += chunk;
    if (Buffer.byteLength(value) > 16384) reject(413, 'Request too large');
  }
  try {
    const parsed = JSON.parse(value || '{}');
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
    return parsed;
  } catch { reject(400, 'Invalid request'); }
}

export function validateInput(data) {
  const number = (key, min, max) => typeof data[key] === 'number' && Number.isFinite(data[key]) && data[key] >= min && data[key] <= max;
  if (data.kind === 'text' && typeof data.text === 'string' && data.text.length > 0 && data.text.length <= 4096) return { kind: 'text', text: data.text };
  if (data.kind === 'key' && typeof data.key === 'string' && data.key.length <= 32 &&
      typeof data.code === 'string' && /^[A-Za-z0-9]{0,32}$/.test(data.code) &&
      number('keyCode', 0, 255) && number('modifiers', 0, 15)) {
    return { kind: 'key', key: data.key, code: data.code, keyCode: data.keyCode, modifiers: data.modifiers };
  }
  if ((data.kind === 'click' || data.kind === 'scroll') && number('x', 0, 16384) && number('y', 0, 16384)) {
    if (data.kind === 'click') return { kind: 'click', x: data.x, y: data.y, clickCount: data.clickCount === 2 ? 2 : 1 };
    if (number('deltaX', -4096, 4096) && number('deltaY', -4096, 4096)) return { kind: 'scroll', x: data.x, y: data.y, deltaX: data.deltaX, deltaY: data.deltaY };
  }
  reject(400, 'Unsupported browser input');
}

export function createBroker({ serviceToken, tenantCredential, createTransport, now = Date.now,
  ttlMs = 15 * 60_000, idleMs = 3 * 60_000, recoveryMs = 30_000,
  publicOrigin = 'https://8examples.com', onStatus = () => {}, onFailure = () => {} }) {
  if (!serviceToken || serviceToken.length < 32) throw new Error('REMOTE_CONNECT_SERVICE_TOKEN must contain at least 32 characters');
  const sessions = new Map();
  const creating = new Set();
  const creationRates = new Map();
  const publicState = (s) => ({ id: s.id, tenant: s.tenant, status: s.status, expiresAt: new Date(s.expires).toISOString() });
  function end(s, status) {
    s.status = status;
    s.codeHash = undefined;
    s.viewer = undefined;
    s.transport?.close();
    s.transport = undefined;
    try { onStatus(s.tenant, publicState(s)); } catch { /* status is also queryable */ }
  }
  function sweep() {
    for (const [id, s] of sessions) {
      if (['waiting', 'connected'].includes(s.status) &&
          (s.expires <= now() || (s.status === 'connected' && s.lastSeen + idleMs <= now()))) end(s, 'expired');
      if (s.expires + 60 * 60_000 < now()) sessions.delete(id);
    }
    for (const [id, rate] of creationRates) if (rate.start + 600_000 < now()) creationRates.delete(id);
  }
  const timer = setInterval(sweep, 5000);
  timer.unref();
  function owner(req, tenant) {
    if (!tenantPattern.test(tenant) || !equal(req.headers['x-remote-tenant-key'], tenantCredential(tenant))) reject(401, 'Invalid Claw credentials');
  }
  function viewer(req, s) {
    if (s.status !== 'connected') reject(410, 'This connection has ended. Ask your Claw for a new link.');
    if (!equal(req.headers['x-remote-viewer'], s.viewer)) reject(401, 'Enter the six-digit code from your Claw.');
    // Recheck assignment/offboarding on every call, including existing sessions.
    if (!equal(s.ownerKey, tenantCredential(s.tenant))) { end(s, 'revoked'); reject(410, 'This connection has ended.'); }
    s.lastSeen = now();
  }
  async function transportRequest(s, action, data) {
    if (s.transport?.closed) s.transport = undefined;
    if (!s.transport) {
      if (action === 'input') throw Object.assign(new Error('Wait for the browser to reconnect'), { retryable: true, code: 'input_not_sent' });
      s.reconnecting ??= (async () => {
        const transport = createTransport(s.tenant);
        try {
          const selected = await transport.request('select', { targetId: s.targetId, allowFallback: true });
          if (s.status !== 'connected') throw new Rejected(410, 'This connection has ended.');
          s.targetId = selected.targetId;
          s.transport = transport;
        } catch (error) { transport.close(); throw error; }
      })().finally(() => { s.reconnecting = undefined; });
      await s.reconnecting;
    }
    const result = await s.transport.request(action, data);
    if (s.status !== 'connected') throw new Rejected(410, 'This connection has ended.');
    if (result.targetId) s.targetId = result.targetId;
    // Healthy tab enumeration alone must not keep broken screenshots alive.
    if (action === 'frame') s.failureSince = undefined;
    return result;
  }

  async function route(req) {
    if (!equal(req.headers.authorization, `Bearer ${serviceToken}`)) reject(401, 'Unauthorized');
    const path = new URL(req.url, 'http://broker').pathname;
    if (req.method === 'GET' && path === '/health') return { ok: true };
    sweep();
    if (req.method === 'POST' && path === '/sessions') {
      const data = await body(req);
      const tenant = data.tenant;
      if (typeof tenant !== 'string') reject(400, 'A tenant is required');
      owner(req, tenant);
      if (data.targetId !== undefined && (typeof data.targetId !== 'string' || !targetPattern.test(data.targetId))) reject(400, 'Invalid browser target');
      if (creating.has(tenant)) reject(409, 'A connection is already being prepared');
      const rate = creationRates.get(tenant) || { start: now(), count: 0 };
      if (++rate.count > 10) reject(429, 'Too many connection requests. Try again later.');
      creationRates.set(tenant, rate);
      if ([...sessions.values()].filter((s) => ['waiting', 'connected'].includes(s.status)).length >= 100) reject(503, 'Remote connections are busy. Try again shortly.');
      creating.add(tenant);
      let transport;
      try {
        // Prove the exact browser tab is reachable BEFORE returning a link.
        transport = createTransport(tenant);
        const selected = await transport.request('select', { targetId: data.targetId });
        for (const s of sessions.values()) if (s.tenant === tenant && ['waiting', 'connected'].includes(s.status)) end(s, 'replaced');
        const id = randomUUID();
        const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
        const s = { id, tenant, codeHash: hash(id + code), ownerKey: tenantCredential(tenant), attempts: 0,
          status: 'waiting', expires: now() + ttlMs, lastSeen: now(), targetId: selected.targetId, transport };
        sessions.set(id, s);
        try { onStatus(tenant, publicState(s)); } catch { /* advisory */ }
        return { ...publicState(s), url: `${publicOrigin}/remote-connect/${id}`, code };
      } catch (error) {
        transport?.close();
        throw error;
      } finally { creating.delete(tenant); }
    }
    const ownerMatch = path.match(/^\/sessions\/([^/]+)$/);
    if (ownerMatch && ['GET', 'DELETE'].includes(req.method)) {
      const tenant = req.headers['x-remote-tenant'];
      if (typeof tenant !== 'string') reject(401, 'Invalid Claw credentials');
      owner(req, tenant);
      const s = sessions.get(ownerMatch[1]);
      if (!s || s.tenant !== tenant) reject(404, 'Connection not found');
      if (req.method === 'DELETE') end(s, 'revoked');
      return publicState(s);
    }
    const match = path.match(/^\/([^/]+)\/(unlock|state|frame|input|tab|complete)$/);
    if (!match || !uuid.test(match[1])) reject(404, 'Connection not found');
    const s = sessions.get(match[1]);
    if (!s) reject(410, 'This connection has ended. Ask your Claw for a new link.');
    const action = match[2];
    if (action === 'unlock' && req.method === 'POST') {
      const data = await body(req);
      if (s.status !== 'waiting') reject(410, 'This code has already been used or the connection has ended. Ask your Claw for a new link.');
      if (!equal(s.ownerKey, tenantCredential(s.tenant))) { end(s, 'revoked'); reject(410, 'This connection has ended.'); }
      if (typeof data.code !== 'string' || !/^\d{6}$/.test(data.code) || !timingSafeEqual(hash(s.id + data.code), s.codeHash)) {
        if (++s.attempts >= 5) end(s, 'locked');
        reject(401, s.status === 'locked' ? 'Too many incorrect codes. Ask your Claw for a new link.' : 'That code is incorrect.');
      }
      s.viewer = randomBytes(32).toString('hex');
      s.codeHash = undefined;
      s.status = 'connected';
      s.lastSeen = now();
      try { onStatus(s.tenant, publicState(s)); } catch { /* advisory */ }
      return { ...publicState(s), viewerToken: s.viewer };
    }
    viewer(req, s);
    if (req.method === 'POST' && action === 'complete') { end(s, 'completed'); return publicState(s); }
    try {
      if (req.method === 'GET' && action === 'state') return { ...publicState(s), ...(await transportRequest(s, 'tabs')) };
      if (req.method === 'GET' && action === 'frame') {
        if (s.framePending || (s.lastFrame !== undefined && now() - s.lastFrame < 100)) reject(429, 'Please wait for the next frame');
        s.lastFrame = now();
        s.framePending = true;
        try { return await transportRequest(s, 'frame'); } finally { s.framePending = false; }
      }
      if (req.method === 'POST' && action === 'input') return await transportRequest(s, 'input', validateInput(await body(req)));
      if (req.method === 'POST' && action === 'tab') {
        const data = await body(req);
        if (typeof data.targetId !== 'string' || !targetPattern.test(data.targetId)) reject(400, 'Invalid browser target');
        return await transportRequest(s, 'select', { targetId: data.targetId });
      }
      reject(405, 'Method not allowed');
    } catch (error) {
      if (!(error instanceof Rejected) && error.retryable === true && s.status === 'connected') {
        s.failureSince ??= now();
        // Fixed categories only; never forward raw CDP/subprocess errors.
        const code = /^(?:cdp_[a-z_]+|bridge_[a-z_]+|browser_[a-z_]+|frame_not_ready|tab_missing|input_not_sent|invalid_endpoint)$/.test(error.code || '') ? error.code : 'browser_interrupted';
        if (!s.lastFailureLog || now() - s.lastFailureLog >= 5000) {
          s.lastFailureLog = now();
          try { onFailure({ tenant: s.tenant, action, code }); } catch { /* advisory */ }
        }
        if (now() - s.failureSince < recoveryMs) throw new Rejected(503, action === 'input'
          ? 'The browser was interrupted. Check the page before continuing; your last input was not resent.'
          : 'Reconnecting to your browser… Keep this page open.', true);
        // A slow renderer must not revoke an otherwise valid viewer. The UI
        // pauses automatic recovery and lets the owner retry or return control.
        // Normal session expiry, idle timeout, and revocation still apply.
        throw new Rejected(503, 'The browser is taking longer to respond. Retry the connection or return control.', true);
      }
      if (!(error instanceof Rejected)) end(s, 'disconnected');
      throw error;
    }
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try { res.end(JSON.stringify(await route(req))); }
    catch (error) {
      res.statusCode = error instanceof Rejected ? error.status : 503;
      // Do not log request bodies, codes, tokens, browser URLs, or subprocess errors.
      res.end(JSON.stringify({ error: error instanceof Rejected ? error.message : 'Browser unavailable. Ask your Claw to open the login tab and create a new connection.',
        ...(error instanceof Rejected && error.retryable ? { retryable: true } : {}) }));
    }
  });
  server.requestTimeout = 35000;
  server.headersTimeout = 10000;
  server.on('close', () => { clearInterval(timer); for (const s of sessions.values()) end(s, 'disconnected'); });
  return server;
}
