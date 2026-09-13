import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./pty-bridge.py', import.meta.url), 'utf8');
export function terminalTransport(tenant) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(tenant)) throw new Error('Invalid tenant');
  return stdioTerminal(spawn('docker', ['exec', '-i', '--user', 'node', '--workdir', '/home/node/.openclaw/workspace',
    `openclaw-${tenant}`, 'python3', '-u', '-c', source], { stdio: ['pipe', 'pipe', 'ignore'] }));
}

// Exported separately so the real PTY can also be tested without Docker.
export function stdioTerminal(child, { maxBytes = 1024 * 1024, timeoutMs = 10000 } = {}) {
  let closed = false, running = true, exitCode = null, nextCommand = 0, sequence = 0, bytes = 0, incoming = '';
  const chunks = [], pending = new Map();
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const readyTimer = setTimeout(() => { rejectReady(new Error('Terminal did not start')); close(); }, timeoutMs);
  readyTimer.unref();
  function close() {
    if (closed) return;
    closed = true; running = false;
    child.stdin.end(JSON.stringify({ action: 'close' }) + '\n');
    const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
    timer.unref(); child.once('exit', () => clearTimeout(timer));
    chunks.length = 0; bytes = 0;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Terminal ended')); }
    pending.clear();
  }
  child.stdin.on('error', () => {});
  child.on('error', () => { rejectReady(new Error('Terminal unavailable')); close(); });
  child.on('exit', () => {
    clearTimeout(readyTimer); rejectReady(new Error('Terminal unavailable'));
    running = false;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Terminal ended')); }
    pending.clear();
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    incoming += data;
    if (incoming.length > 256 * 1024) { close(); return; }
    let at;
    while ((at = incoming.indexOf('\n')) !== -1) {
      const line = incoming.slice(0, at); incoming = incoming.slice(at + 1);
      try {
        const event = JSON.parse(line);
        if (event.event === 'ready') { clearTimeout(readyTimer); resolveReady(); }
        if (event.event === 'output' && !closed) {
          const size = Buffer.byteLength(event.data, 'base64');
          chunks.push({ sequence: ++sequence, data: event.data, size }); bytes += size;
          while (bytes > maxBytes && chunks.length > 1) bytes -= chunks.shift().size;
        }
        if (event.event === 'exit') { running = false; exitCode = event.code; }
        if (event.reply && pending.has(event.reply)) {
          const p = pending.get(event.reply); clearTimeout(p.timer); pending.delete(event.reply); p.resolve();
        }
      } catch { close(); }
    }
  });
  async function request(action, data) {
    await ready;
    if (closed || !running) throw new Error('Terminal ended');
    const id = ++nextCommand;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Terminal input interrupted')); close(); }, timeoutMs);
      timer.unref(); pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, action, ...data }) + '\n');
    });
  }
  return { ready, request, close,
    read(after = 0) {
      const available = chunks.filter(chunk => chunk.sequence > after);
      // Bound each response, while retaining older chunks for retry/reload.
      let size = 0;
      const batch = [];
      for (const chunk of available) { if (size >= 128 * 1024) break; batch.push(chunk); size += chunk.size; }
      return { chunks: batch.map(({ sequence, data }) => ({ sequence, data })),
        cursor: batch.at(-1)?.sequence ?? after,
        truncated: chunks.length > 0 && after < chunks[0].sequence - 1,
        running, exitCode, more: (batch.at(-1)?.sequence ?? after) < sequence };
    },
  };
}
