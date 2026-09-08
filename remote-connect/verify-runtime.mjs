// Read only: prove the actual container gateway loaded this code generation.
// Fresh CLI/plugin tests cannot detect a running gateway retaining old hooks.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
const exec = promisify(execFile);
const selected = process.argv[2];
const tenants = JSON.parse(readFileSync(path.join(process.env.MOC_ROOT, 'data/tenants.json'), 'utf8'));
const marker = `managed-remote-login active ${createHash('sha256').update(readFileSync(new URL('./plugin/index.mjs', import.meta.url))).digest('hex')}`;
const {stdout} = await exec('docker', ['ps', '--format', '{{.Names}}']);
const running = new Set(stdout.trim().split('\n'));
const pending = new Set(tenants.filter(t => !t.offboardedAt && t.tier !== 'desktop' && (!selected || selected === '*' || t.id === selected) && running.has(`openclaw-${t.id}`)).map(t => t.id));
if (!pending.size) throw new Error('No selected running gateway to verify');
const count = pending.size;
for (let attempt=0; attempt<36 && pending.size; attempt++) {
  for (const tenant of pending) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(tenant)) throw new Error('Invalid tenant ID');
    const container = `openclaw-${tenant}`;
    const start = (await exec('docker', ['inspect', '--format', '{{.State.StartedAt}}', container])).stdout.trim();
    const logs = await exec('docker', ['logs', '--since', start, '--tail', '2000', container], {maxBuffer: 4*1024*1024});
    if ((logs.stdout+logs.stderr).includes(marker)) pending.delete(tenant);
  }
  if (pending.size) await new Promise(resolve => setTimeout(resolve, 5000));
}
if (pending.size) throw new Error('The running gateway has not loaded the new hooks: '+[...pending].join(', '));
console.log(`PASS: ${count} running gateway(s) activated the deployed plugin code. Stopped Claws were left stopped.`);
