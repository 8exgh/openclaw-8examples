import http from 'node:http';
import WebSocket from 'ws';
import { dockerSocket, gatewayConfiguration } from './docker-socket.mjs';

const scopes = ['operator.admin', 'operator.approvals', 'operator.pairing', 'operator.read', 'operator.write'];
export function dashboardProxyTransport(tenant, { configuration = gatewayConfiguration, connect = dockerSocket } = {}) {
  let closed = false;
  const sockets = new Set();
  const config = configuration(tenant);
  // A rejected setup promise is observed by request('select').
  config.catch(() => {});
  const agent = new http.Agent({ keepAlive: true, maxSockets: 6, maxFreeSockets: 2 });
  let port;
  function socket() {
    if (closed) throw new Error('Dashboard connection ended');
    const stream = connect(tenant, port);
    sockets.add(stream);
    stream.on('close', () => sockets.delete(stream));
    return stream;
  }
  agent.createConnection = socket;
  async function ready() { const c = await config; if (closed) throw new Error('Dashboard connection ended'); port = c.port; return c; }
  const api = {
    get closed() { return closed; },
    close() { closed = true; agent.destroy(); for (const s of sockets) s.destroy(); sockets.clear(); },
    async request(action) {
      if (action === 'tabs') return {};
      if (action !== 'select') throw new Error('Use the native dashboard');
      const c = await ready();
      // The same local backend authentication is used for every browser
      // connection. Prove it works before issuing the one-time link.
      await new Promise((resolve, reject) => {
        const upstream = new WebSocket(`ws://127.0.0.1:${port}/`, { createConnection: socket, handshakeTimeout: 10000 });
        const timer = setTimeout(() => { upstream.terminate(); reject(new Error('Gateway handshake timed out')); }, 12000);
        const finish = error => { clearTimeout(timer); upstream.close(); error ? reject(error) : resolve(); };
        upstream.on('error', () => finish(new Error('Dashboard unavailable')));
        upstream.on('message', raw => {
          let message; try { message = JSON.parse(raw); } catch { return; }
          if (message.event === 'connect.challenge') upstream.send(JSON.stringify(connectFrame('probe', c.token)));
          if (message.type === 'res' && message.id === 'probe') finish(message.ok && message.payload?.type === 'hello-ok' ? undefined : new Error('Dashboard authentication failed'));
        });
      });
      return { targetId: 'dashboard' };
    },
    async http(req, res, pathname) {
      const c = await ready();
      // Headers from a user's browser cannot select credentials, upstream
      // hosts or tenants. In particular no browser cookies cross this hop.
      const headers = { authorization: `Bearer ${c.token}`, host: `127.0.0.1:${port}` };
      for (const key of ['accept', 'content-type', 'content-length', 'range', 'if-range']) if (req.headers[key]) headers[key] = req.headers[key];
      const upstream = http.request({ hostname: '127.0.0.1', port, path: pathname, method: req.method, headers, agent }, response => {
        const outgoing = {};
        for (const key of ['content-type', 'content-length', 'content-disposition', 'content-range', 'accept-ranges', 'content-security-policy']) if (response.headers[key]) outgoing[key] = response.headers[key];
        if (response.headers.location) {
          const location = new URL(response.headers.location, `http://127.0.0.1:${port}`);
          if (location.host !== `127.0.0.1:${port}` || location.protocol !== 'http:') { response.destroy(); res.writeHead(502); res.end('Invalid dashboard redirect'); return; }
          outgoing.location = location.pathname + location.search + location.hash;
        }
        outgoing['cache-control'] = 'no-store, private';
        res.writeHead(response.statusCode, outgoing);
        response.pipe(res);
        res.on('close', () => response.destroy());
      });
      const timer = setTimeout(() => upstream.destroy(new Error('Dashboard request timed out')), 120000);
      upstream.on('close', () => clearTimeout(timer));
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Dashboard connection interrupted'); });
      req.on('aborted', () => upstream.destroy());
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    },
    async websocket(downstream, authorize) {
      const c = await ready();
      const upstream = new WebSocket(`ws://127.0.0.1:${port}/`, { createConnection: socket, handshakeTimeout: 10000, maxPayload: 32 * 1024 * 1024 });
      let connected = false, connectId, alive = true;
      const end = () => { clearInterval(timer); upstream.terminate(); downstream.terminate(); };
      const timer = setInterval(() => {
        try { authorize(); if (!alive) return end(); alive = false; downstream.ping(); } catch { end(); }
      }, 15000);
      timer.unref();
      downstream.on('pong', () => { alive = true; });
      for (const ws of [upstream, downstream]) { ws.on('error', end); ws.on('close', end); }
      upstream.on('message', (raw, binary) => {
        try {
          authorize();
          if (binary) return end();
          const message = JSON.parse(raw);
          if (message.type === 'res' && message.id === connectId) {
            connected = message.ok === true && message.payload?.type === 'hello-ok';
            // A temporary viewer must never acquire a reusable device token.
            if (message.payload?.auth) delete message.payload.auth.deviceToken;
          }
          if (downstream.readyState === WebSocket.OPEN) downstream.send(JSON.stringify(message));
        } catch { end(); }
      });
      downstream.on('message', (raw, binary) => {
        try {
          authorize();
          if (binary || upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount > 32 * 1024 * 1024) return end();
          const message = JSON.parse(raw);
          if (message.type === 'req' && message.method === 'connect') {
            if (connectId) return end();
            connectId = message.id;
            upstream.send(JSON.stringify(connectFrame(message.id, c.token, message.params)));
          } else {
            if (!connected) return end();
            upstream.send(raw, { binary: false });
          }
        } catch { end(); }
      });
    },
  };
  return api;
}

function connectFrame(id, token, browser = {}) {
  return { type: 'req', id, method: 'connect', params: {
    minProtocol: 3, maxProtocol: 4,
    client: { id: 'gateway-client', version: '8examples-dashboard', platform: 'node', mode: 'backend', displayName: 'Temporary OpenClaw dashboard' },
    role: 'operator', scopes,
    caps: Array.isArray(browser.caps) ? browser.caps.filter(c => typeof c === 'string' && /^[a-z0-9-]{1,64}$/.test(c)).slice(0, 64) : [],
    auth: { token },
  } };
}
