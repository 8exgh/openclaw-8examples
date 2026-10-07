import { WebSocketServer } from 'ws';
const route = /^\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/proxy(\/.*)$/;

export function attachDashboardProxy(server) {
  const original = server.listeners('request');
  server.removeAllListeners('request');
  server.on('request', async (req, res) => {
    const match = req.url.match(route);
    if (!match) { for (const listener of original) listener.call(server, req, res); return; }
    try {
      const { transport } = server.authorizeViewer(req, match[1]);
      await transport.http(req, res, match[2]);
    } catch (error) {
      res.writeHead(error.status || 503, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.status ? error.message : 'Dashboard unavailable' }));
    }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const match = req.url.match(route);
    try {
      if (!match || match[2] !== '/') throw Object.assign(new Error('Not found'), { status: 404 });
      const authorize = () => server.authorizeViewer(req, match[1]);
      const { transport } = authorize();
      sockets.handleUpgrade(req, socket, head, ws => {
        transport.websocket(ws, authorize).catch(() => ws.terminate());
      });
    } catch (error) { socket.end(`HTTP/1.1 ${error.status || 503} Rejected\r\nConnection: close\r\n\r\n`); }
  });
  server.on('close', () => { for (const ws of sockets.clients) ws.terminate(); sockets.close(); });
  return server;
}
