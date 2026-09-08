import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import plugin, { requestsHandoff } from './plugin/index.mjs';
import { installRemoteRuntime } from './workspace.mjs';

test('runtime instructions are added only where the helper is installed, without replacing the system prompt', (t) => {
  const workspaceDir = mkdtempSync(path.join(tmpdir(), 'remote-hook-'));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  mkdirSync(path.join(workspaceDir, 'remote-connect'));
  writeFileSync(path.join(workspaceDir, 'remote-connect/session.mjs'), '');
  const hooks = new Map();
  plugin.register({ on(name, handler) { hooks.set(name, handler); } });
  const prompt = hooks.get('before_prompt_build')({}, { workspaceDir });
  assert.match(prompt.appendSystemContext, /INSTALLED and AUTHORIZED/);
  assert.equal(prompt.systemPrompt, undefined);
  assert.equal(hooks.get('before_prompt_build')({}, { workspaceDir: '/missing-workspace' }), undefined);
});

test('shared-room handoffs ask for private chat without creating a connection', async (t) => {
  const workspaceDir = mkdtempSync(path.join(tmpdir(), 'remote-hook-'));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  mkdirSync(path.join(workspaceDir, 'remote-connect'));
  writeFileSync(path.join(workspaceDir, 'remote-connect/session.mjs'), 'throw new Error("must not execute")');
  const hooks = new Map();
  plugin.register({ on(name, handler) { hooks.set(name, handler); } });
  const response = await hooks.get('before_agent_reply')({ cleanedBody: 'Give me a fresh browser link' }, { workspaceDir, sessionKey: 'agent:main:telegram:group:123' });
  assert.equal(response.handled, true);
  assert.match(response.reply.text, /private chat/);
});

test('runtime configuration preserves other plugins and owner configuration', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'remote-hook-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'config'));
  const file = path.join(dir, 'config/openclaw.json');
  writeFileSync(file, JSON.stringify({ commands: { ownerAllowFrom: ['owner'] }, plugins: { allow: ['example'], load: { paths: ['/existing'] }, entries: { example: { enabled: true } } } }));
  installRemoteRuntime(dir);
  const once = readFileSync(file, 'utf8');
  installRemoteRuntime(dir);
  assert.equal(readFileSync(file, 'utf8'), once);
  const config = JSON.parse(once);
  assert.deepEqual(config.commands.ownerAllowFrom, ['owner']);
  assert.equal(config.plugins.entries.example.enabled, true);
  assert.equal(config.plugins.entries['managed-remote-login'].hooks.allowConversationAccess, true);
  assert.deepEqual(config.plugins.allow, ['example', 'managed-remote-login']);
  assert.equal(config.plugins.load.paths[0], '/existing');
  assert.ok(readFileSync(path.join(dir, 'config/extensions/managed-remote-login/index.mjs'), 'utf8').includes('before_prompt_build'));
});

test('handoff requests include broken browser links and direct credential entry', () => {
  for (const text of ['Give me a fresh browser link', 'I want to sign in myself', 'I want to enter my password directly in your browser', 'Set up remote browser login']) assert.equal(requestsHandoff(text), true, text);
  for (const text of ['Summarize my calendar', 'What is localhost?', 'Write a password validation function', 'Do not create a remote browser login', 'Explain remote browser login']) assert.equal(requestsHandoff(text), false, text);
});
