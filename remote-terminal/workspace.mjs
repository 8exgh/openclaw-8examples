import { assertSafePath, updateConfig, updateText, updateBlock } from '../owner-state/index.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function terminalInstructions() { return readFileSync(new URL('./instructions.md', import.meta.url), 'utf8'); }

// Only explicit deployment enables this capability. No automatic fleet activation.
export function installTerminalWorkspace(dir, tenant, origin = 'https://8examples.com') {
  for (const relative of ['config/openclaw.json', 'workspace/AGENTS.md', 'workspace/remote-terminal/account.json', 'workspace/remote-terminal/session.mjs', 'workspace/skills/remote-terminal/SKILL.md']) assertSafePath(path.join(dir, relative));
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(tenant)) throw new Error('Invalid tenant');
  const workspace = path.join(dir, 'workspace'), remote = path.join(workspace, 'remote-terminal');
  const skill = path.join(workspace, 'skills/remote-terminal');
  mkdirSync(remote, { recursive: true }); mkdirSync(skill, { recursive: true });
  const key = path.join(dir, '.remote-terminal-key');
  if (!existsSync(key)) writeFileSync(key, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
  chmodSync(key, 0o600);
  const token = readFileSync(key, 'utf8').trim(); if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('Invalid terminal credential');
  const account = path.join(remote, 'account.json');
  writeFileSync(account, JSON.stringify({ tenant, token, origin }) + '\n', { mode: 0o600 }); chmodSync(account, 0o600);
  writeFileSync(path.join(remote, 'session.mjs'), readFileSync(new URL('./session.mjs', import.meta.url)));
  const instructions = terminalInstructions();
  updateText(dir, 'skill-remote-terminal', path.join(skill, 'SKILL.md'), '---\nname: remote-terminal\ndescription: Give the owner a temporary interactive terminal in this Claw’s container.\n---\n\n' + instructions);
  const agents = path.join(workspace, 'AGENTS.md');
  updateBlock(dir, 'managed-remote-terminal', agents, instructions);
  const names = ['index.mjs', 'package.json', 'openclaw.plugin.json'];
  const hash = createHash('sha256'); for (const name of names) hash.update(readFileSync(new URL(`./plugin/${name}`, import.meta.url)));
  const relative = `managed-plugins/managed-remote-terminal/${hash.digest('hex')}`;
  const pluginDir = path.join(dir, 'config', relative); assertSafePath(pluginDir); mkdirSync(pluginDir, { recursive: true });
  // Deployment protects credentials with umask 077. Every code directory must
  // still be traversable by the gateway user, including mkdir's parent paths.
  for (const directory of [path.join(dir, 'config/managed-plugins'), path.dirname(pluginDir), pluginDir]) chmodSync(directory, 0o755);
  for (const name of names) {
    const file = path.join(pluginDir, name);
    assertSafePath(file);
    writeFileSync(file, readFileSync(new URL(`./plugin/${name}`, import.meta.url)));
    chmodSync(file, 0o644);
  }
  updateConfig(dir, 'terminal-plugin', config => {
    config.plugins ??= {}; config.plugins.entries ??= {}; config.plugins.load ??= {};
    config.plugins.entries['managed-remote-terminal'] = { enabled: true, ...config.plugins.entries['managed-remote-terminal'], hooks: { allowConversationAccess: true, allowPromptInjection: true, ...config.plugins.entries['managed-remote-terminal']?.hooks } };
    config.plugins.load.paths = (config.plugins.load.paths || []).filter(p => !p.startsWith('/home/node/.openclaw/managed-plugins/managed-remote-terminal/'));
    config.plugins.load.paths.push(`/home/node/.openclaw/${relative}`);
    if (Array.isArray(config.plugins.allow) && !config.plugins.allow.includes('managed-remote-terminal')) config.plugins.allow.push('managed-remote-terminal');
    return config;
  });
  if (process.getuid?.() === 0) for (const file of [key, remote, account, path.join(remote, 'session.mjs'), skill, path.join(skill, 'SKILL.md'), agents, pluginDir, ...names.map(name => path.join(pluginDir, name))]) if (existsSync(file)) chownSync(file, 1000, 1000);
}
