import { readFileSync } from 'node:fs';
import path from 'node:path';
import { installPhoneHandoff } from './install.mjs';
const root = process.env.MOC_ROOT, selected = process.argv[2];
if (!root || !selected) throw new Error('Set MOC_ROOT and select a tenant or *');
const tenants = JSON.parse(readFileSync(path.join(root, 'data/tenants.json'), 'utf8'));
const results = [];
for (const tenant of tenants) {
  if (tenant.offboardedAt || tenant.tier === 'desktop' || !tenant.capabilities?.phone?.enabled || (selected !== '*' && tenant.id !== selected)) continue;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(tenant.id)) throw new Error('Invalid tenant ID');
  const result = installPhoneHandoff(path.join(root, 'tenants', tenant.id), tenant);
  results.push(result); console.log(JSON.stringify(result));
}
if (!results.length || !results.some(result => result.enabled)) throw new Error('No eligible private owner route was installed');
console.log(`Installed ${results.filter(result => result.enabled).length} private chat handoffs; staged ${results.filter(result => !result.enabled).length} awaiting a verified chat connection. OpenClaw reloads its configuration; no containers were recreated.`);
