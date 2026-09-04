import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { capability } from './capabilities/registry.js';
import { parseEnv, renderAgentInstructions } from './provisioner/render.js';
import { tenantDir } from './store.js';
import type { Tenant } from './types.js';

/** Read only this tenant's owned numbers, then refresh its phone awareness. */
export async function syncPhoneAccount(tenant: Tenant): Promise<string | null> {
  if (tenant.offboardedAt || !tenant.capabilities.phone?.enabled) {
    throw new Error('Phone capability must be enabled on an active tenant');
  }
  if (tenant.tier === 'desktop') throw new Error('Phone sync requires a container tenant workspace');
  const dir = tenantDir(tenant.id);
  const env = parseEnv(readFileSync(path.join(dir, '.env'), 'utf8'));
  const url = env.get('PHONE_GATEWAY_URL');
  const key = env.get('PHONE_GATEWAY_API_KEY');
  if (!url || !/^https?:\/\//.test(url) || !key || !/^pgw_[0-9a-f]{32}$/.test(key)) {
    throw new Error('A phone gateway URL and tenant-scoped phone credential are required');
  }
  const response = await fetch(`${url.replace(/\/+$/, '')}/numbers`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Phone number lookup failed (HTTP ${response.status}); existing number preserved`);
  const numbers: unknown = await response.json();
  if (!Array.isArray(numbers) || numbers.length > 1 || numbers.some((n) =>
    !n || typeof n.phoneNumber !== 'string' || !/^\+[1-9]\d{7,14}$/.test(n.phoneNumber))) {
    throw new Error('Unexpected phone number response; existing number preserved');
  }
  const phoneNumber: string | null = numbers[0]?.phoneNumber ?? null;
  const workspace = path.join(dir, 'workspace');
  mkdirSync(path.join(workspace, 'phone'), { recursive: true });
  writeFileSync(path.join(workspace, 'phone', 'account.json'), JSON.stringify({
    phoneNumber, checkedAt: new Date().toISOString(),
  }, null, 2) + '\n');
  mkdirSync(path.join(workspace, 'capabilities'), { recursive: true });
  writeFileSync(path.join(workspace, 'capabilities', 'phone.md'), capability('phone').workspaceDoc);
  renderAgentInstructions(tenant);
  return phoneNumber;
}
