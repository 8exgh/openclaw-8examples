import { readFileSync, writeFileSync } from 'node:fs';

const [action] = process.argv.slice(2);
try {
  if (!['create', 'status', 'revoke'].includes(action)) throw new Error('Usage: node remote-terminal/session.mjs create | status | revoke');
  const account = JSON.parse(readFileSync(new URL('./account.json', import.meta.url), 'utf8'));
  const saved = new URL('./last-session.json', import.meta.url);
  const previous = action === 'create' ? undefined : JSON.parse(readFileSync(saved, 'utf8'));
  const endpoint = new URL(`/api/remote-terminal/sessions${previous ? `/${previous.id}` : ''}`, account.origin);
  const response = await fetch(endpoint, {
    method: action === 'create' ? 'POST' : action === 'revoke' ? 'DELETE' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${account.token}`, 'X-Remote-Tenant': account.tenant },
    ...(action === 'create' ? { body: JSON.stringify({ tenant: account.tenant }) } : {}),
    signal: AbortSignal.timeout(25000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Remote terminal HTTP ${response.status}`);
  if (action === 'create') writeFileSync(saved, JSON.stringify({ id: result.id, expiresAt: result.expiresAt }) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.code === 'ENOENT' ? 'No terminal connection found. Create one first.' : error.message);
  process.exitCode = 1;
}
