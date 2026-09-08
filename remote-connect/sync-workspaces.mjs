import { readFileSync } from 'node:fs';
import path from 'node:path';
import { installRemoteWorkspace } from './workspace.mjs';

const root = process.env.MOC_ROOT;
if (!root) throw new Error('Set MOC_ROOT to the managed-openclaw checkout');
const selected = process.argv[2];
const tenants = JSON.parse(readFileSync(path.join(root, 'data/tenants.json'), 'utf8'));
let count = 0;
for (const tenant of tenants) {
  if (tenant.offboardedAt || tenant.tier === 'desktop' || (selected && tenant.id !== selected)) continue;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(tenant.id)) throw new Error('Invalid tenant id');
  installRemoteWorkspace(path.join(root, 'tenants', tenant.id), tenant.id, process.env.REMOTE_CONNECT_PUBLIC_ORIGIN);
  count++;
}
if (!count) throw new Error('No eligible tenants found');
console.log(`Installed remote login instructions and helper for ${count} Claw(s). No containers restarted.`);
