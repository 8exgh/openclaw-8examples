// Local integration-test TLS termination. WebKit correctly rejects Secure
// cookies over HTTP, including loopback, so exercise the production cookie.
import { createServer } from 'node:https';
import { request } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export async function testHttps(scratch, upstream, origin) {
  const key = path.join(scratch, 'test.key'), cert = path.join(scratch, 'test.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const headers = { ...req.headers, host: new URL(upstream).host };
    if (headers.origin === origin) headers.origin = upstream;
    const proxy = request(new URL(req.url, upstream), { method: req.method, headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    proxy.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(proxy);
  });
  await new Promise(resolve => server.listen(Number(new URL(origin).port), '127.0.0.1', resolve));
  return server;
}
