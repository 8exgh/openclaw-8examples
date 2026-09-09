import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { privateOwner, revision } from './install.mjs';
const exec = promisify(execFile);
const selected = process.argv[2], root = process.env.MOC_ROOT;
if (!root || !selected) throw new Error('Set MOC_ROOT and select a tenant or *');
const tenants = JSON.parse(readFileSync(path.join(root, 'data/tenants.json'), 'utf8'));
const marker = `managed-phone-handoff active ${createHash('sha256').update(readFileSync(new URL('./plugin/index.mjs', import.meta.url))).digest('hex')}`;
const running = new Set((await exec('docker', ['ps', '--format', '{{.Names}}'])).stdout.trim().split('\n'));
const pending = new Set();
for (const tenant of tenants) {
  if (tenant.offboardedAt || tenant.tier === 'desktop' || !tenant.capabilities?.phone?.enabled || (selected !== '*' && tenant.id !== selected)) continue;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(tenant.id)) throw new Error('Invalid tenant ID');
  const c = JSON.parse(readFileSync(path.join(root, 'tenants', tenant.id, 'config/openclaw.json'), 'utf8'));
  if (!privateOwner(tenant, c)) continue;
  if (!c.plugins?.load?.paths?.includes(`/home/node/.openclaw/managed-plugins/managed-phone-handoff/${revision()}`)) throw new Error(`${tenant.id}: wrong installed generation`);
  if (running.has(`openclaw-${tenant.id}`)) pending.add(tenant.id);
  else console.log(`${tenant.id}: installed; stopped container left stopped`);
}
if (!pending.size) throw new Error('No selected running gateway to verify');
const count = pending.size;
const reasons = new Map();
const probe = readFileSync(new URL('./inspect-runtime.mjs', import.meta.url), 'utf8');
for (let attempt = 0; attempt < 90 && pending.size; attempt++) {
  await Promise.all([...pending].map(async tenant => {
    const container = `openclaw-${tenant}`;
    const start = (await exec('docker', ['inspect', '--format', '{{.State.StartedAt}}', container])).stdout.trim();
    const logs = await exec('docker', ['logs', '--since', start, '--tail', '2000', container], { maxBuffer: 4 * 1024 * 1024 });
    const active = (logs.stdout + logs.stderr).split('\n').filter(line => line.includes('managed-phone-handoff active')).at(-1);
    if (!active?.includes(marker)) { reasons.set(tenant, 'Gateway has not loaded this generation'); return; }
    try {
      const result = await new Promise((resolve, reject) => {
        const child = execFile('docker', ['exec', '-i', container, 'node', '--input-type=module'], { timeout: 15000, maxBuffer: 65536 }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve(stdout));
        child.stdin.end(probe);
      });
      console.log(`${tenant}: ${result.trim()}`); pending.delete(tenant);
    } catch (error) {
      reasons.set(tenant, error.stderr?.match(/Error: ([^\n]+)/)?.[1] || 'Runtime probe pending');
    }
  }));
  if (pending.size && attempt % 6 === 0) console.log(JSON.stringify({ waiting: [...pending].map(tenant => ({ tenant, reason: reasons.get(tenant) })) }));
  if (pending.size) await new Promise(resolve => setTimeout(resolve, 5000));
}
if (pending.size) throw new Error('Gateways have not activated and synchronized the new handoff: ' + JSON.stringify([...reasons]));
console.log(`PASS: ${count} running Claw(s) loaded the reviewed handoff and synchronized their own phone history.`);
