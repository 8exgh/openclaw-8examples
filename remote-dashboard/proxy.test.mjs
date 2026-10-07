import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { createBroker } from '../remote-connect/broker.mjs';
import { attachDashboardProxy } from './proxy-broker.mjs';
import { dashboardProxyTransport } from './proxy-transport.mjs';

test('native HTTP and WebSocket proxy keeps credentials server-side and enforces the complete handoff lifetime', async t => {
  const service = 's'.repeat(64), key = 'k'.repeat(64), gatewayToken = 'permanent-test-gateway-credential';
  let now = 100000, active = true;
  const seen = [];
  const gateway = http.createServer((req, res) => {
    seen.push(req.headers);
    assert.equal(req.headers.authorization, `Bearer ${gatewayToken}`);
    assert.equal(req.headers.cookie, undefined);
    res.setHeader('content-type', 'application/octet-stream');
    if (req.method === 'POST') req.pipe(res); else res.end('native dashboard bytes');
  });
  const upstreamWs = new WebSocketServer({ server: gateway });
  upstreamWs.on('connection', (ws, req) => {
    assert.equal(req.headers.origin, undefined);
    ws.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'test' } }));
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.method === 'connect') {
        assert.equal(m.params.auth.token, gatewayToken);
        assert.equal(m.params.device, undefined);
        assert.equal(m.params.client.id, 'gateway-client');
        assert.equal(m.params.role, 'operator');
        ws.send(JSON.stringify({ type: 'res', id: m.id, ok: true, payload: { type: 'hello-ok', auth: { deviceToken: 'must-not-escape' } } }));
      } else ws.send(JSON.stringify({ type: 'res', id: m.id, ok: true, payload: { method: m.method } }));
    });
  });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const port = gateway.address().port;
  const transports = [];
  const broker = attachDashboardProxy(createBroker({ serviceToken: service, publicPath: 'remote-dashboard', recreateTransport: false, now: () => now, ttlMs: 120000,
    tenantCredential: id => active && id === 'alice' ? key : undefined,
    createTransport: id => { const tr = dashboardProxyTransport(id, { configuration: async () => ({ token: gatewayToken, port, basePath: '' }), connect: () => net.connect(port, '127.0.0.1') }); transports.push(tr); return tr; },
  }));
  broker.listen(0, '127.0.0.1'); await once(broker, 'listening');
  t.after(() => { broker.shutdown(); for (const ws of upstreamWs.clients) ws.terminate(); upstreamWs.close(); gateway.closeAllConnections(); gateway.close(); });
  const origin = `http://127.0.0.1:${broker.address().port}`;
  const call = (path, data, token, headers = {}) => fetch(origin + path, { method: data === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${service}`, 'content-type': 'application/json', ...(token ? { 'x-remote-viewer': token } : {}), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const create = async () => (await call('/sessions', { tenant: 'alice' }, undefined, { 'x-remote-tenant-key': key })).json();
  const session = await create();
  assert(!JSON.stringify(session).includes(gatewayToken));
  const viewer = (await (await call(`/${session.id}/unlock`, { code: session.code })).json()).viewerToken;
  assert.equal((await call(`/${session.id}/proxy/`)).status, 401);
  assert.equal((await call(`/${session.id}/handoff`, {})).status, 401);
  const ticket = (await (await call(`/${session.id}/handoff`, {}, viewer)).json()).ticket;
  assert.equal((await call(`/${session.id}/enter`, { ticket: '0'.repeat(64) })).status, 401);
  const entered = await call(`/${session.id}/enter`, { ticket });
  assert.equal((await entered.json()).viewerToken, viewer);
  assert.equal((await call(`/${session.id}/enter`, { ticket })).status, 401);
  const response = await call(`/${session.id}/proxy/assets/app.js`, undefined, viewer, { cookie: 'website_account=secret', 'x-remote-tenant': 'bob', 'x-forwarded-host': 'evil' });
  assert.equal(await response.text(), 'native dashboard bytes');
  assert.equal(response.headers.get('cache-control'), 'no-store, private');
  assert.equal(seen.at(-1)['x-remote-tenant'], undefined);
  const upload = Buffer.alloc(2 * 1024 * 1024, 42);
  const uploaded = await fetch(`${origin}/${session.id}/proxy/upload`, { method: 'POST', headers: { authorization: `Bearer ${service}`, 'x-remote-viewer': viewer, 'content-type': 'application/octet-stream' }, body: upload });
  assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()), upload);
  const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/${session.id}/proxy/`, { headers: { authorization: `Bearer ${service}`, 'x-remote-viewer': viewer } });
  const incoming = []; ws.on('message', raw => incoming.push(JSON.parse(raw)));
  await once(ws, 'open');
  await once(ws, 'message');
  ws.send(JSON.stringify({ type: 'req', id: 'connect', method: 'connect', params: { role: 'node', auth: { token: 'spoofed' }, device: { id: 'spoofed' } } }));
  const [hello] = await once(ws, 'message');
  assert.equal(JSON.parse(hello).payload.type, 'hello-ok');
  assert.equal(JSON.parse(hello).payload.auth.deviceToken, undefined);
  ws.send(JSON.stringify({ type: 'req', id: 'rpc', method: 'status' }));
  const [rpc] = await once(ws, 'message'); assert.equal(JSON.parse(rpc).payload.method, 'status');
  const closed = once(ws, 'close');
  now += 120001;
  assert.equal((await call(`/${session.id}/proxy/`, undefined, viewer)).status, 410);
  await closed;
  assert(transports[0].closed);
  const second = await create();
  const secondViewer = (await (await call(`/${second.id}/unlock`, { code: second.code })).json()).viewerToken;
  assert.equal((await call(`/${second.id}/proxy/`, undefined, viewer)).status, 401);
  active = false;
  assert.equal((await call(`/${second.id}/proxy/`, undefined, secondViewer)).status, 410);
});
