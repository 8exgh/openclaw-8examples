import { randomBytes } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const templates = new URL('../templates/workspace/', import.meta.url);
export function remoteInstructions() {
  return readFileSync(new URL('remote-connect/AGENTS.md', templates), 'utf8');
}

// Also used by a dedicated rollout that does not restart or reconfigure Claws.
export function installRemoteWorkspace(dir, tenant, origin = 'https://8examples.com') {
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
  writeFileSync(path.join(skill, 'SKILL.md'), readFileSync(new URL('skills/remote-login/SKILL.md', templates)));
  const agents = path.join(workspace, 'AGENTS.md');
  const existing = existsSync(agents) ? readFileSync(agents, 'utf8') : '';
  const clean = existing.replace(/<!-- managed-remote-connect:start -->[\s\S]*?<!-- managed-remote-connect:end -->\n?/g, '').trimEnd();
  writeFileSync(agents, clean + '\n\n' + remoteInstructions());
  if (process.getuid?.() === 0) {
    for (const file of [keyFile, remote, accountFile, path.join(remote, 'session.mjs'), skill, path.join(skill, 'SKILL.md'), agents]) chownSync(file, 1000, 1000);
  }
}
