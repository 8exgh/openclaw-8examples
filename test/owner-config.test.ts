import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderTenant, renderAgentInstructions } from '../src/provisioner/render.js';
import { installTerminalWorkspace } from '../remote-terminal/workspace.mjs';
import { reconcile, updateConfig, withMissingDefaults } from '../owner-state/index.mjs';
import type { Tenant } from '../src/types.js';
import { ensurePlugins } from '../src/provisioner/docker.js';

test('defaults advance while owner values, arrays, additions and deletions take precedence', () => {
  const base = { plugin: { enabled: true, timeout: 10, removed: 'old' }, list: ['a'], untouched: 1 };
  const current = { plugin: { enabled: false, timeout: 10, own: 'secret' }, list: [], untouched: 1 };
  assert.deepEqual(reconcile(base, current, { plugin: { enabled: true, timeout: 20, removed: 'new' }, list: ['a', 'b'], untouched: 2 }),
    { plugin: { enabled: false, timeout: 20, own: 'secret' }, list: [], untouched: 2 });
});

test('owner plugins, credentials, instructions and installed skills survive repeated provisioning', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'owner-config-')), prior = process.env.MOC_TENANTS_DIR;
  process.env.MOC_TENANTS_DIR = root;
  t.after(() => { if (prior === undefined) delete process.env.MOC_TENANTS_DIR; else process.env.MOC_TENANTS_DIR = prior; rmSync(root, { recursive: true, force: true }); });
  const tenant: Tenant = { id: 'owner-test', name: 'Owner', contact: {}, channel: 'telegram', gatewayPort: 29998, tier: 'container', createdAt: new Date().toISOString(), capabilities: {}, nudgeLog: [] };
  const fleet = { releaseChannel: 'latest' as const, image: 'test/image', nextPort: 1 };
  renderTenant(tenant, fleet);
  const dir = path.join(root, tenant.id), workspace = path.join(dir, 'workspace'), file = path.join(dir, 'config/openclaw.json');
  installTerminalWorkspace(dir, tenant.id);
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.plugins.entries.ownerPlugin = { enabled: true, config: { apiKey: 'owner-test-secret', nested: { selection: ['mine'] } } };
  config.plugins.installs = { ownerPlugin: { source: 'npm', spec: 'owner-plugin@1.2.3' } };
  config.plugins.allow = ['ownerPlugin'];
  config.plugins.load.paths = ['/home/node/.openclaw/owner-plugin'];
  config.plugins.entries['managed-remote-terminal'].enabled = false;
  config.plugins.entries['managed-remote-login'].hooks.allowPromptInjection = false;
  delete config.tools.web;
  config.agents.defaults.model = { primary: 'my-provider/my-model', fallbacks: [] };
  writeFileSync(file, JSON.stringify(config));
  const agents = readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8') + '\nOwner instructions: this is my computer.\n';
  writeFileSync(path.join(workspace, 'AGENTS.md'), agents);
  writeFileSync(path.join(workspace, 'HEARTBEAT.md'), 'My schedule only.\n');
  mkdirSync(path.join(workspace, 'skills/owner-plugin'));
  writeFileSync(path.join(workspace, 'skills/owner-plugin/SKILL.md'), 'Owner skill.\n');
  writeFileSync(path.join(workspace, 'skills/remote-terminal/SKILL.md'), 'My customized terminal instructions.\n');
  for (let n = 0; n < 3; n++) { renderTenant(tenant, fleet); renderAgentInstructions(tenant); }
  const kept = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(kept.plugins, config.plugins);
  assert.deepEqual(kept.agents.defaults.model, config.agents.defaults.model);
  assert.equal(kept.tools.web, undefined);
  assert.equal(readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'), agents);
  assert.equal(readFileSync(path.join(workspace, 'HEARTBEAT.md'), 'utf8'), 'My schedule only.\n');
  assert.equal(readFileSync(path.join(workspace, 'skills/owner-plugin/SKILL.md'), 'utf8'), 'Owner skill.\n');
  assert.equal(readFileSync(path.join(workspace, 'skills/remote-terminal/SKILL.md'), 'utf8'), 'My customized terminal instructions.\n');
  rmSync(path.join(workspace, 'HEARTBEAT.md'));
  renderTenant(tenant, fleet);
  assert.equal(existsSync(path.join(workspace, 'HEARTBEAT.md')), false);
  assert(readdirSync(path.join(dir, 'config/owner-backups')).length > 0);
  writeFileSync(path.join(workspace, 'remote-terminal/status.json'), JSON.stringify({ status: 'connected', expiresAt: new Date(Date.now() + 60000).toISOString() }));
  assert.throws(() => renderTenant(tenant, fleet), /owner is using their terminal/);
});

test('first adoption keeps every existing value byte for byte, and malformed config is never replaced', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'owner-adopt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'config'));
  const file = path.join(dir, 'config/openclaw.json'), original = '{ "plugins": { "allow": [] }, "custom": "keep" }\n';
  writeFileSync(file, original);
  // Nothing missing: the owner's file is not rewritten at all.
  updateConfig(dir, 'provisioned-config', () => ({ plugins: { allow: ['default'] } }), { adoptExisting: true });
  assert.equal(readFileSync(file, 'utf8'), original);
  writeFileSync(file, '{ unfinished owner edit');
  assert.throws(() => updateConfig(dir, 'provisioned-config', () => ({})), /left untouched/);
  assert.equal(readFileSync(file, 'utf8'), '{ unfinished owner edit');
  const outside = path.join(dir, 'host-owned.json'); writeFileSync(outside, '{"private":"host"}');
  rmSync(file); symlinkSync(outside, file);
  assert.throws(() => updateConfig(dir, 'provisioned-config', () => ({})), /symbolic link/);
  assert.equal(readFileSync(outside, 'utf8'), '{"private":"host"}');
});

test('adopting a reserve worker\'s older config still delivers defaults it predates', t => {
  // openclaw10 (2026-10-30): rendered as reserve inventory before the
  // model-gateway timeout existed, adopted on activation, and every later
  // render read the missing key as an owner deletion — so OpenClaw's 120s
  // idle watchdog kept killing its long job-application turns.
  const dir = mkdtempSync(path.join(tmpdir(), 'owner-adopt-reserve-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'config'));
  const file = path.join(dir, 'config/openclaw.json');
  const reserve = { models: { providers: { gateway: { baseUrl: 'http://model-gateway:8790', api: 'anthropic-messages' } } },
    agents: { defaults: { model: { primary: 'gateway/claude-opus-4-8' } } }, plugins: { allow: [] }, owner: 'kept' };
  writeFileSync(file, JSON.stringify(reserve, null, 2) + '\n');
  const defaults = () => ({ models: { providers: { gateway: { baseUrl: 'http://model-gateway:8790', api: 'anthropic-messages', timeoutSeconds: 900 } } },
    agents: { defaults: { model: { primary: 'gateway/claude-opus-5-5' } } }, plugins: { allow: ['default'], entries: { minimax: { enabled: true } } } });
  const read = () => JSON.parse(readFileSync(file, 'utf8'));

  updateConfig(dir, 'provisioned-config', defaults, { adoptExisting: true });
  let config = read();
  assert.equal(config.models.providers.gateway.timeoutSeconds, 900, 'a default the config predates arrives on adoption');
  assert.deepEqual(config.plugins.entries, { minimax: { enabled: true } });
  assert.equal(config.agents.defaults.model.primary, 'gateway/claude-opus-4-8', 'existing values win on adoption');
  assert.deepEqual(config.plugins.allow, [], 'existing arrays win on adoption');
  assert.equal(config.owner, 'kept');

  updateConfig(dir, 'provisioned-config', defaults);
  assert.equal(read().models.providers.gateway.timeoutSeconds, 900, 'stable on the next render');

  // After adoption the ledger exists, so a real owner deletion still wins.
  config = read(); delete config.models.providers.gateway.timeoutSeconds; writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  updateConfig(dir, 'provisioned-config', defaults);
  assert.equal(read().models.providers.gateway.timeoutSeconds, undefined, 'an owner deletion after adoption is honoured');
});

test('withMissingDefaults only ever adds keys', () => {
  assert.deepEqual(withMissingDefaults({ a: 1, b: { c: false }, list: [] }, { a: 2, b: { c: true, d: 3 }, list: ['x'], e: { f: 1 } }),
    { a: 1, b: { c: false, d: 3 }, list: [], e: { f: 1 } });
  assert.equal(withMissingDefaults(null, { a: 1 }), null);
});

test('provisioning neither upgrades nor grants consent to an existing owner-installed managed-provider package', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'owner-plugin-version-'));
  const priorRoot = process.env.MOC_TENANTS_DIR, priorPath = process.env.PATH, priorLog = process.env.OWNER_DOCKER_TEST_LOG;
  process.env.MOC_TENANTS_DIR = root; process.env.PATH = root + ':' + priorPath; process.env.OWNER_DOCKER_TEST_LOG = path.join(root, 'docker-called');
  t.after(() => { for (const [key, value] of Object.entries({ MOC_TENANTS_DIR: priorRoot, PATH: priorPath, OWNER_DOCKER_TEST_LOG: priorLog })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); });
  writeFileSync(path.join(root, 'docker'), '#!/bin/sh\nprintf called >> "$OWNER_DOCKER_TEST_LOG"\nexit 1\n', { mode: 0o755 });
  const project = path.join(root, 'owner-test/config/npm/projects/openclaw-brave-plugin-owner'); mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, 'package.json'), JSON.stringify({ dependencies: { '@openclaw/brave-plugin': '1.2.3' } }));
  assert.deepEqual(ensurePlugins({ id: 'owner-test' } as Tenant, ['@openclaw/brave-plugin']), []);
  assert.equal(existsSync(path.join(root, 'docker-called')), false);
  assert.equal(JSON.parse(readFileSync(path.join(project, 'package.json'), 'utf8')).dependencies['@openclaw/brave-plugin'], '1.2.3');
});
