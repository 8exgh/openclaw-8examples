import { readFileSync, writeFileSync, renameSync, existsSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const [tenantDirectory, relayAddress, ...extra] = process.argv.slice(2);
if (!tenantDirectory || !relayAddress || extra.length) throw new Error('Usage: node integration/connect-tenant.mjs /absolute/tenants/openclaw1 https://your-relay-host');
const dir = realpathSync(resolve(tenantDirectory));
const clawId = basename(dir);
if (!/^[a-z0-9-]{1,64}$/.test(clawId)) throw new Error('Invalid tenant directory name');
const url = new URL(relayAddress);
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
  throw new Error('Use an HTTPS relay origin');
}
const publishers = JSON.parse(readFileSync(new URL('../config.local.json', import.meta.url), 'utf8'));
const token = publishers[clawId];
if (!/^gws_[a-f0-9]{64}$/.test(token ?? '')) throw new Error('Run integration/configure.mjs for this tenant first');
const envFile = join(dir, '.env');
if (!existsSync(envFile)) throw new Error('Tenant .env does not exist; select an existing tenant');
const before = readFileSync(envFile, 'utf8');
const changes = new Map([['GLASSES_RELAY_URL', url.origin], ['GLASSES_RELAY_TOKEN', token]]);
const lines = before.split('\n').filter((line) => !/^GLASSES_RELAY_(URL|TOKEN)=/.test(line));
while (lines.at(-1) === '') lines.pop();
for (const [name, value] of changes) lines.push(`${name}=${value}`);
const staging = `${envFile}.glasses-${process.pid}`;
writeFileSync(staging, lines.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
renameSync(staging, envFile);
console.log(`Glasses relay credentials saved for ${clawId}. From the fleet repository, run: npm run cli -- enable ${clawId} glasses`);
