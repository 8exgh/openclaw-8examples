import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stdioTerminal } from './transport.mjs';

async function until(predicate) { for (let n = 0; n < 100; n++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error('Terminal expectation timed out'); }
test('real PTY supports sizing, Unicode, no-echo password prompts, Ctrl+C, cursor replay and cleanup', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'terminal-pty-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, '.bashrc'), "PS1='PTY_TEST> '\n");
  const child = spawn('python3', ['-u', '-c', readFileSync(new URL('./pty-bridge.py', import.meta.url), 'utf8')], {
    cwd: dir, env: { PATH: process.env.PATH, HOME: dir, LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const terminal = stdioTerminal(child); t.after(() => terminal.close()); await terminal.ready;
  const text = (after = 0) => terminal.read(after).chunks.map(c => Buffer.from(c.data, 'base64').toString()).join('');
  const input = value => terminal.request('input', { data: Buffer.from(value).toString('base64') });
  await until(() => text().includes('PTY_TEST> '));
  await terminal.request('resize', { cols: 101, rows: 33 });
  await input("test -t 0 && printf 'TTY:yes\\n'; stty size; printf 'UTF8:å猫\\n'\r");
  await until(() => text().includes('33 101') && text().includes('UTF8:å猫'));
  await input("read -rs -p 'Secret prompt: ' secret; printf '\\nSECRET_LENGTH:%s\\n' \"${#secret}\"\r");
  // Match the active prompt, not the earlier echo of its shell command.
  await until(() => /Secret prompt: $/.test(text()));
  const cursor = terminal.read().cursor;
  await input('synthetic-secret\r');
  await until(() => text().includes('SECRET_LENGTH:16'));
  const recent = terminal.read(cursor).chunks.map(c => Buffer.from(c.data, 'base64').toString()).join('');
  assert(!recent.includes('synthetic-secret'));
  await input("printf 'INTERRUPT_%s\\n' READY; sleep 60\r");
  await until(() => text().includes('INTERRUPT_READY\r\n'));
  const interruptCursor = terminal.read().cursor;
  await input('\x03');
  await until(() => text(interruptCursor).includes('PTY_TEST> '));
  await input("printf 'AFTER_%s\\n' INTERRUPT; printf 'saved' > terminal-proof.txt\r");
  // The file may become visible before stdout reaches Node through the PTY.
  await until(() => existsSync(path.join(dir, 'terminal-proof.txt')) && text().includes('AFTER_INTERRUPT\r\n'));
  assert.deepEqual(terminal.read(cursor), terminal.read(cursor), 'Output retries do not consume data');
  terminal.close(); await until(() => child.exitCode !== null);
  assert.equal(terminal.read().chunks.length, 0, 'Close discards retained terminal output');
  assert.equal(readFileSync(path.join(dir, 'terminal-proof.txt'), 'utf8'), 'saved');
  assert(!existsSync(path.join(dir, '.bash_history')));
});
