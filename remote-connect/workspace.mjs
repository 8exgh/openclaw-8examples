import { assertSafePath, updateConfig, updateText, updateBlock } from '../owner-state/index.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const templates = new URL('../templates/workspace/', import.meta.url);
export function remoteInstructions() {
  return readFileSync(new URL('remote-connect/AGENTS.md', templates), 'utf8');
}

export function installRemoteRuntime(dir) {
  assertSafePath(path.join(dir, 'config/openclaw.json'));
  const configFile = path.join(dir, 'config/openclaw.json');
  if (!existsSync(configFile)) return;
  // A new module path bypasses the running gateway's manifest/module caches.
  // Keep the revision outside plugin config: the old cached schema must still
  // accept the update before OpenClaw can restart into the new generation.
  const names = ['index.mjs', 'package.json', 'openclaw.plugin.json'];
  const hash = createHash('sha256');
  for (const name of names) hash.update(readFileSync(new URL(`./plugin/${name}`, import.meta.url)));
  const revision = hash.digest('hex');
  const relative = `managed-plugins/managed-remote-login/${revision}`;
  const pluginDir = path.join(dir, 'config', relative);
  assertSafePath(pluginDir);
  mkdirSync(pluginDir, { recursive: true });
  for (const directory of [path.join(dir, 'config/managed-plugins'), path.dirname(pluginDir), pluginDir]) {
    chmodSync(directory, 0o755);
    if (process.getuid?.() === 0) chownSync(directory, 1000, 1000);
  }
  for (const name of names) {
    const file = path.join(pluginDir, name);
    assertSafePath(file);
    writeFileSync(file, readFileSync(new URL(`./plugin/${name}`, import.meta.url)));
    if (process.getuid?.() === 0) chownSync(file, 1000, 1000);
  }
  if (process.getuid?.() === 0) chownSync(pluginDir, 1000, 1000);
  updateConfig(dir, 'browser-plugin', config => {
    config.plugins ??= {};
    config.plugins.entries ??= {};
    config.plugins.entries['managed-remote-login'] = { enabled: true, ...config.plugins.entries['managed-remote-login'], hooks: { allowConversationAccess: true, allowPromptInjection: true, ...config.plugins.entries['managed-remote-login']?.hooks } };
    // Remove only the retired revision marker we used to put in plugin config;
    // revision selection now lives in the module path, outside the plugin schema.
    const legacyConfig = config.plugins.entries['managed-remote-login'].config;
    if (legacyConfig && Object.keys(legacyConfig).length === 1 && typeof legacyConfig.revision === 'string') delete config.plugins.entries['managed-remote-login'].config;
    config.plugins.load ??= {};
    config.plugins.load.paths ??= [];
    const legacy = '/home/node/.openclaw/extensions/managed-remote-login';
    const location = `/home/node/.openclaw/${relative}`;
    config.plugins.load.paths = config.plugins.load.paths.filter(p => p !== legacy && !p.startsWith('/home/node/.openclaw/managed-plugins/managed-remote-login/'));
    if (!config.plugins.load.paths.includes(location)) config.plugins.load.paths.push(location);
    if (Array.isArray(config.plugins.allow) && !config.plugins.allow.includes('managed-remote-login')) config.plugins.allow.push('managed-remote-login');
    return config;
  });
  // Remove the previous auto-discovered copy to avoid duplicate plugin IDs.
  assertSafePath(path.join(dir, 'config/extensions/managed-remote-login'));
  rmSync(path.join(dir, 'config/extensions/managed-remote-login'), { recursive: true, force: true });
}

// Also used by a dedicated rollout that does not restart or reconfigure Claws.
export function installRemoteWorkspace(dir, tenant, origin = 'https://8examples.com') {
  for (const relative of ['config/openclaw.json', 'workspace/AGENTS.md', 'workspace/remote-connect/account.json', 'workspace/remote-connect/session.mjs', 'workspace/skills/remote-login/SKILL.md']) assertSafePath(path.join(dir, relative));
  const workspace = path.join(dir, 'workspace');
  const remote = path.join(workspace, 'remote-connect');
  mkdirSync(remote, { recursive: true });
  const keyFile = path.join(dir, '.remote-connect-key');
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  chmodSync(keyFile, 0o600);
  const token = readFileSync(keyFile, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error(`Invalid remote credential for ${tenant}`);
  const accountFile = path.join(remote, 'account.json');
  writeFileSync(accountFile, JSON.stringify({ tenant, token, origin }) + '\n', { mode: 0o600 });
  chmodSync(accountFile, 0o600);
  writeFileSync(path.join(remote, 'session.mjs'), readFileSync(new URL('remote-connect/session.mjs', templates)));
  const skill = path.join(workspace, 'skills/remote-login');
  mkdirSync(skill, { recursive: true });
  updateText(dir, 'skill-remote-login', path.join(skill, 'SKILL.md'), readFileSync(new URL('skills/remote-login/SKILL.md', templates), 'utf8'));
  const agents = path.join(workspace, 'AGENTS.md');
  updateBlock(dir, 'managed-remote-connect', agents, remoteInstructions());
  if (process.getuid?.() === 0) {
    for (const file of [keyFile, remote, accountFile, path.join(remote, 'session.mjs'), skill, path.join(skill, 'SKILL.md'), agents]) if (existsSync(file)) chownSync(file, 1000, 1000);
  }
}
