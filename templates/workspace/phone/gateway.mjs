import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Keep credentials in the process environment, outside model-visible commands.
export async function requestGateway(method, route, body, { env = process.env, fetchImpl = fetch } = {}) {
  const key = env.PHONE_GATEWAY_API_KEY;
  if (!key || !/^pgw_[0-9a-f]{32}$/.test(key)) throw new Error('Missing tenant phone gateway credential');
  const base = new URL(env.PHONE_GATEWAY_URL);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('Invalid phone gateway URL');
  }
  if (!['GET', 'POST', 'DELETE'].includes(method)) throw new Error('Use GET, POST, or DELETE');
  if (!route.startsWith('/') || route.startsWith('//')) throw new Error('Use a gateway-relative path');
  const url = new URL(route, base);
  if (url.origin !== base.origin) throw new Error('Request must stay on the configured gateway');
  const response = await fetchImpl(url, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const text = (await response.text()).split(key).join('[REDACTED]');
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, body: data };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [method, route, file, ...extra] = process.argv.slice(2);
    if (!method || !route || extra.length) throw new Error('Usage: node phone/gateway.mjs METHOD /path [json-file]');
    if (file && method === 'GET') throw new Error('GET does not take a JSON file');
    const body = file ? JSON.parse(readFileSync(file, 'utf8')) : method === 'POST' ? {} : undefined;
    const result = await requestGateway(method, route, body);
    console.log(JSON.stringify(result));
    if (result.status < 200 || result.status >= 300) process.exitCode = 1;
  } catch (error) {
    const key = process.env.PHONE_GATEWAY_API_KEY;
    const message = error instanceof Error ? error.message : 'Phone request failed';
    console.error(key ? message.split(key).join('[REDACTED]') : message);
    process.exitCode = 1;
  }
}
