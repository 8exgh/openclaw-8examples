import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const [clawId, ...extra] = process.argv.slice(2);
if (!/^[a-z0-9-]{1,64}$/.test(clawId ?? '') || extra.length) throw new Error('Usage: node integration/configure.mjs openclaw1');
process.umask(0o077);
const root = new URL('../', import.meta.url);
const config = new URL('config.local.json', root);
const env = new URL('.env', root);
const publishers = existsSync(config) ? JSON.parse(readFileSync(config, 'utf8')) : {};
publishers[clawId] ??= `gws_${randomBytes(32).toString('hex')}`;
writeFileSync(config, JSON.stringify(publishers, null, 2) + '\n', { mode: 0o600 });
if (!existsSync(env)) writeFileSync(env, readFileSync(new URL('.env.example', root), 'utf8')
  .replace('SESSION_ENCRYPTION_KEY=\n', `SESSION_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}\n`), { mode: 0o600 });
console.log(`Private relay configuration ready in ${fileURLToPath(root)}. Existing keys were preserved.`);
