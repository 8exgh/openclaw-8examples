import { readFileSync } from 'node:fs';

// Authentication is added here, never reconstructed from redacted agent history.
try {
  const [file, ...extra] = process.argv.slice(2);
  if (!file || extra.length) throw new Error('Usage: node glasses/publish-summary.mjs glasses/summary.json');
  const token = process.env.GLASSES_RELAY_TOKEN;
  if (!/^gws_[a-f0-9]{64}$/.test(token ?? '')) throw new Error('Glasses summary credential is not configured');
  const base = new URL(process.env.GLASSES_RELAY_URL);
  if (base.protocol !== 'https:' || base.username || base.password) throw new Error('Glasses relay URL must be HTTPS');
  const body = JSON.parse(readFileSync(file, 'utf8'));
  const response = await fetch(new URL('/v1/summaries', base), { method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Summary delivery failed (HTTP ${response.status}); retry with the same actionId`);
  const result = await response.json();
  console.log(JSON.stringify({ accepted: true, eventId: result.eventId }));
} catch (error) {
  const token = process.env.GLASSES_RELAY_TOKEN;
  const text = error instanceof Error ? error.message : 'Summary delivery failed';
  console.error(token ? text.split(token).join('[REDACTED]') : text);
  process.exitCode = 1;
}
