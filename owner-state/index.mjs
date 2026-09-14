// Provisioning supplies defaults. Changes made inside the owner's Claw win.
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, chownSync, chmodSync, rmSync, lstatSync, constants } from 'node:fs';
import path from 'node:path';

const absent = Symbol('absent');
const object = value => value !== absent && value !== null && typeof value === 'object' && !Array.isArray(value);
const member = (value, key) => object(value) && Object.hasOwn(value, key) ? value[key] : absent;
const pluginFamily = value => typeof value === 'string' && value.match(/\/managed-plugins\/([^/]+)\//)?.[1];

export function reconcile(base, current, desired, location = '') {
  if (equal(current, base)) return desired;
  if (equal(desired, base)) return current;
  // Plugin path/trust lists are sets: keep owner additions and removals while
  // replacing unchanged managed plugin revisions. Other arrays stay atomic.
  if (['plugins.load.paths', 'plugins.allow'].includes(location) && [base, current, desired].every(Array.isArray)) {
    const result = current.filter(value => !base.includes(value) || desired.includes(value));
    for (const value of desired) {
      if (base.includes(value) || result.includes(value)) continue;
      const family = pluginFamily(value);
      if (family && base.some(p => pluginFamily(p) === family) && !current.some(p => pluginFamily(p) === family)) continue;
      result.push(value);
    }
    return result;
  }
  if (object(current) && object(desired) && (object(base) || base === absent)) {
    const result = {};
    for (const key of new Set([...Object.keys(base === absent ? {} : base), ...Object.keys(current), ...Object.keys(desired)])) {
      const value = reconcile(member(base, key), member(current, key), member(desired, key), location ? `${location}.${key}` : key);
      if (value !== absent) Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  // Includes explicit deletion, false, null, custom arrays and conflicting edits.
  return current;
}

export function assertSafePath(file) {
  let current = path.parse(path.resolve(file)).root;
  for (const part of path.resolve(file).slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('Provisioning will not follow an owner-controlled symbolic link.'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
  }
}
function read(file) { assertSafePath(file); return existsSync(file) ? readFileSync(file, { encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NOFOLLOW }) : undefined; }
function atomic(file, text, original) {
  if (read(file) !== original) throw new Error(`Owner changed ${path.basename(file)} during provisioning; retry without overwriting their edit.`);
  if (text === original) return;
  mkdirSync(path.dirname(file), { recursive: true });
  const prior = existsSync(file) ? statSync(file) : undefined;
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, text, { flag: 'wx', mode: prior ? prior.mode & 0o777 : 0o600 });
  if (process.getuid?.() === 0) chownSync(temporary, prior?.uid ?? 1000, prior?.gid ?? 1000);
  renameSync(temporary, file);
}
function ledger(dir, name) {
  if (!/^[a-z0-9.-]+$/.test(name)) throw new Error('Invalid ownership ledger name');
  const folder = path.join(dir, '.owner-state');
  mkdirSync(folder, { recursive: true, mode: 0o700 }); chmodSync(folder, 0o700);
  if (process.getuid?.() === 0) chownSync(folder, 1000, 1000);
  return path.join(folder, `${name}.json`);
}
function parse(text, label) {
  try { return JSON.parse(text); } catch { throw new Error(`${label} is not valid JSON; left untouched. Repair it before provisioning.`); }
}

export function updateConfig(dir, name, build, { adoptExisting = false } = {}) {
  const file = path.join(dir, 'config/openclaw.json'), original = read(file);
  const current = original === undefined ? {} : parse(original, 'Owner configuration');
  if (!object(current)) throw new Error('Owner configuration must be an object; left untouched.');
  const state = ledger(dir, name), previous = read(state);
  const desired = build(structuredClone(current));
  const next = previous === undefined
    ? (original !== undefined && adoptExisting ? current : desired)
    : reconcile(parse(previous, 'Provisioning baseline'), current, desired);
  if (!equal(next, current) || original === undefined) {
    if (original !== undefined) {
      const backups = path.join(dir, 'config/owner-backups');
      assertSafePath(backups);
      mkdirSync(backups, { recursive: true, mode: 0o700 });
      if (process.getuid?.() === 0) chownSync(backups, 1000, 1000);
      atomic(path.join(backups, `openclaw-${Date.now()}-${randomBytes(4).toString('hex')}.json`), original, undefined);
    }
    atomic(file, JSON.stringify(next, null, 2) + '\n', original);
  }
  // The baseline is the proposed defaults, never a copy that erases owner edits.
  atomic(state, JSON.stringify(desired) + '\n', previous);
  return next;
}

export function assertOwnerIdle(dir) {
  const privateFile = path.join(dir, '.remote-terminal-status.json');
  const file = existsSync(privateFile) ? privateFile : path.join(dir, 'workspace/remote-terminal/status.json');
  if (!existsSync(file)) return;
  const status = parse(read(file), 'Terminal status');
  if (status.status === 'connected' && Date.parse(status.expiresAt) > Date.now()) throw new Error('The owner is using their terminal. Provisioning is deferred until they finish.');
}

export function updateText(dir, name, file, desired) {
  const original = read(file), state = ledger(dir, name), prior = read(state);
  const baseline = prior === undefined ? undefined : parse(prior, 'Provisioning baseline');
  if (original === undefined ? prior === undefined || baseline === null : baseline === original) {
    if (desired === null) rmSync(file, { force: true }); else atomic(file, desired, original);
  }
  atomic(state, JSON.stringify(desired) + '\n', prior);
}

// Update only the provisioner's named block. The owner's surrounding text is
// always retained, and editing/deleting the block overrides future defaults.
export function updateBlock(dir, name, file, desired) {
  const original = read(file) ?? '';
  const pattern = new RegExp(`<!-- ${name}:start -->[\\s\\S]*?<!-- ${name}:end -->\\n?`);
  const match = original.match(pattern), current = match?.[0];
  const state = ledger(dir, name), prior = read(state);
  const baseline = prior === undefined ? undefined : parse(prior, 'Provisioning baseline');
  if ((prior === undefined && current === undefined) || (prior !== undefined && current === baseline)) {
    const next = match ? (desired ? original.replace(pattern, desired) : original.replace(pattern, '').trimEnd() + '\n') : desired ? original.trimEnd() + '\n\n' + desired : original;
    atomic(file, next, read(file));
  }
  atomic(state, JSON.stringify(desired) + '\n', prior);
}

// AGENTS.md predates named provisioning blocks. Adopt its existing body and
// track it independently of the browser/phone/terminal integration blocks.
export function updateAgentBody(dir, desired) {
  const file = path.join(dir, 'workspace/AGENTS.md'), original = read(file);
  const pattern = /\n*<!-- managed-(?:remote-connect|remote-terminal|phone-handoff):start -->[\s\S]*?<!-- managed-(?:remote-connect|remote-terminal|phone-handoff):end -->\n?/g;
  const blocks = original?.match(pattern) ?? [];
  const body = original?.replace(pattern, '').trimEnd();
  const nextBody = desired.trimEnd();
  const state = ledger(dir, 'agent-body'), prior = read(state);
  if (original === undefined && prior === undefined || prior !== undefined && body === parse(prior, 'Provisioning baseline')) {
    atomic(file, nextBody + '\n' + blocks.join(''), original);
  }
  atomic(state, JSON.stringify(nextBody) + '\n', prior);
}
