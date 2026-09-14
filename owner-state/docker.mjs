import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, chownSync } from 'node:fs';
import path from 'node:path';
import { assertOwnerIdle } from './index.mjs';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const ADMIN_CAPABILITIES = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'SETGID', 'SETUID', 'SETPCAP', 'NET_BIND_SERVICE', 'SYS_CHROOT', 'SETFCAP'];
export function ownerImage(dir) {
  const file = path.join(dir, '.owner-image.json');
  if (!existsSync(file)) return undefined;
  const state = JSON.parse(readFileSync(file, 'utf8'));
  if (!/^sha256:[a-f0-9]{64}$/.test(state.image)) throw new Error('Invalid owner image checkpoint');
  return state.image;
}
export function checkpointOwnerImage(dir, tenant) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(tenant)) throw new Error('Invalid tenant');
  if (!existsSync(path.join(dir, '.owner-admin'))) return;
  assertOwnerIdle(dir);
  let container;
  try { container = JSON.parse(docker(['inspect', `openclaw-${tenant}`]))[0]; }
  catch (error) { if (/No such (object|container)/i.test(String(error.stderr))) return; throw error; }
  const file = path.join(dir, '.owner-image.json');
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  const baseImage = previous?.baseImage || container.Image;
  const baseEnv = previous?.baseEnv ?? JSON.parse(docker(['image', 'inspect', baseImage]))[0].Config.Env ?? [];
  const defaults = new Map(baseEnv.map(value => { const at = value.indexOf('='); return [value.slice(0, at), value.slice(at + 1)]; }));
  const changes = [];
  // Docker commits runtime environment too. Restore image defaults and blank
  // injected credentials so escrow/reassignment cannot revive keys from images.
  for (const entry of container.Config.Env || []) {
    const key = entry.slice(0, entry.indexOf('='));
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid environment key');
    changes.push('--change', `ENV ${key}=${JSON.stringify(defaults.get(key) || '')}`);
  }
  const tag = `openclaw-owner/${tenant}:current`;
  docker(['commit', '--pause=true', ...changes, `openclaw-${tenant}`, tag]);
  const image = JSON.parse(docker(['image', 'inspect', tag]))[0].Id;
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Owner image checkpoint failed');
  writeFileSync(file + '.tmp', JSON.stringify({ image, baseImage, baseEnv, savedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
  if (process.getuid?.() === 0) chownSync(file + '.tmp', 1000, 1000);
  renameSync(file + '.tmp', file);
  return image;
}
