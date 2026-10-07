import { Duplex } from 'node:stream';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const inspect = `
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync('/home/node/.openclaw/openclaw.json', 'utf8'));
const resolve = value => value?.source === 'env' ? process.env[value.id] : typeof value === 'string' ? value.replace(/\\$\\{([A-Z_][A-Z0-9_]*)\\}/g, (_, name) => process.env[name] || '') : undefined;
const token = resolve(config.gateway?.auth?.token) || process.env.OPENCLAW_GATEWAY_TOKEN;
if (!token || config.gateway?.controlUi?.enabled === false) process.exit(1);
console.log(JSON.stringify({token, port: config.gateway?.port || 18789, basePath: config.gateway?.controlUi?.basePath || ''}));
`;
export async function gatewayConfiguration(tenant) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(tenant)) throw new Error('Invalid tenant');
  const { stdout } = await promisify(execFile)('docker', ['exec', '--user', 'node', `openclaw-${tenant}`, 'node', '-e', inspect], { timeout: 10000, maxBuffer: 16384 });
  const config = JSON.parse(stdout);
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || typeof config.token !== 'string' || !/^\/[a-zA-Z0-9/_-]*$|^$/.test(config.basePath)) throw new Error('Invalid gateway configuration');
  return config;
}

// A streaming, fixed-destination connection inside the tenant's network
// namespace. Nothing listens on a new port, and no browser process is needed.
export function dockerSocket(tenant, port) {
  let idleTimer;
  const touch = () => {
    clearTimeout(idleTimer);
    if (socket.timeout > 0) { idleTimer = setTimeout(() => socket.emit('timeout'), socket.timeout); idleTimer.unref(); }
  };
  const child = spawn('docker', ['exec', '-i', '--user', 'node', `openclaw-${tenant}`, 'node', '-e',
    "const s=require('node:net').connect(Number(process.argv[1]),'127.0.0.1');s.on('error',()=>process.exit(1));process.stdin.pipe(s);s.pipe(process.stdout);s.on('close',()=>process.exit(0));process.stdin.on('end',()=>s.end());", String(port)], { stdio: ['pipe', 'pipe', 'ignore'] });
  const socket = new Duplex({
    read() { child.stdout.resume(); },
    write(data, encoding, callback) { touch(); child.stdin.write(data, encoding, callback); },
    final(callback) { child.stdin.end(callback); },
    destroy(error, callback) { clearTimeout(idleTimer); child.stdin.destroy(); child.stdout.destroy(); child.kill(); callback(error); },
  });
  child.stdout.on('data', chunk => { touch(); if (!socket.push(chunk)) child.stdout.pause(); });
  child.stdout.on('end', () => socket.push(null));
  child.on('error', error => socket.destroy(error));
  child.stdin.on('error', error => socket.destroy(error));
  child.on('exit', code => { if (code) socket.destroy(new Error('Gateway connection ended')); });
  socket.setTimeout = (ms, callback) => { socket.timeout = ms; if (callback) socket.once('timeout', callback); touch(); return socket; };
  socket.setNoDelay = socket.setKeepAlive = () => socket;
  socket.ref = () => { child.ref(); child.stdin.ref?.(); child.stdout.ref?.(); return socket; };
  socket.unref = () => { child.unref(); child.stdin.unref?.(); child.stdout.unref?.(); return socket; };
  socket.remoteAddress = '127.0.0.1';
  return socket;
}
