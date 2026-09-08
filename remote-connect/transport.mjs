import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./browser-client.mjs', import.meta.url), 'utf8') + '\n' +
  readFileSync(new URL('./browser-bridge.mjs', import.meta.url), 'utf8').replace("import { createBrowserClient } from './browser-client.mjs';", '');
const interrupted = code => Object.assign(new Error('Browser connection interrupted'), { code, retryable: true });

export function browserTransport(tenant) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(tenant)) throw new Error('Invalid tenant');
  // The program comes from this trusted installation, not writable workspace.
  const child = spawn('docker', ['exec', '-i', `openclaw-${tenant}`, 'node', '--input-type=module', '-e', source], { stdio: ['pipe', 'pipe', 'ignore'] });
  let nextId = 0;
  const pending = new Map();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    child.stdin.end();
    child.kill();
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(interrupted('bridge_closed'));
    }
    pending.clear();
  };
  child.on('error', close);
  child.on('exit', close);
  child.stdin.on('error', close);
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const message = JSON.parse(line);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(Object.assign(new Error(message.error), { code: message.code, retryable: message.retryable === true }));
      else request.resolve(message.result);
    } catch { close(); }
  });
  return {
    close,
    get closed() { return closed; },
    request(action, data = {}) {
      if (closed || pending.size >= 32) return Promise.reject(interrupted(closed ? 'bridge_closed' : 'bridge_busy'));
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(interrupted('bridge_timeout')); close(); }, 25000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, action, data }) + '\n');
      });
    },
  };
}
