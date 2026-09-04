import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pickNudge } from '../src/nudges/engine.js';
import { syncPhoneAccount } from '../src/phone.js';
import { renderTenant } from '../src/provisioner/render.js';
import type { Fleet, Tenant } from '../src/types.js';

const fleet: Fleet = { releaseChannel: 'latest', image: 'test/image:latest', nextPort: 1 };

test('phone awareness follows the tenant gateway, survives renders, and never exposes its key', async (t) => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'phone-awareness-'));
  const oldRoot = process.env.MOC_TENANTS_DIR;
  process.env.MOC_TENANTS_DIR = scratch;
  t.after(() => {
    if (oldRoot === undefined) delete process.env.MOC_TENANTS_DIR;
    else process.env.MOC_TENANTS_DIR = oldRoot;
    rmSync(scratch, { recursive: true, force: true });
  });
  const tenant: Tenant = {
    id: 'phone-test', name: 'Phone Test', contact: { phone: '+15555550199' },
    channel: 'whatsapp', gatewayPort: 29995, tier: 'container',
    createdAt: new Date().toISOString(), modelAccess: 'assigned',
    capabilities: { phone: { enabled: true }, sms: { enabled: false } }, nudgeLog: [],
  };
  const dir = path.join(scratch, tenant.id);
  const workspace = path.join(dir, 'workspace');
  const agents = () => readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8');
  renderTenant(tenant, fleet);
  assert.match(agents(), /BOTH calls and SMS/);
  assert.match(agents(), /GET \$PHONE_GATEWAY_URL\/numbers/);
  assert.doesNotMatch(agents(), /Your assigned assistant phone number/);
  assert.doesNotMatch(agents().split('## What you can offer to unlock')[1], /\*\*Text messaging \(SMS\)\*\*/);

  const key = `pgw_${'a'.repeat(32)}`;
  writeFileSync(path.join(dir, '.env'), `PHONE_GATEWAY_URL=https://phone.example/\nPHONE_GATEWAY_API_KEY=${key}\n`);
  let result: unknown = [{ phoneNumber: '+15555550123', sid: 'PN-test' }];
  let status = 200;
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'https://phone.example/numbers');
    assert.equal(options.method ?? 'GET', 'GET');
    assert.deepEqual(options.headers, { Authorization: `Bearer ${key}` });
    return new Response(JSON.stringify(result), { status });
  });

  const configBefore = readFileSync(path.join(dir, 'config/openclaw.json'), 'utf8');
  const envBefore = readFileSync(path.join(dir, '.env'), 'utf8');
  assert.equal(await syncPhoneAccount(tenant), '+15555550123');
  assert.match(agents(), /Your assigned assistant phone number: \*\*\+15555550123\*\*/);
  assert.doesNotMatch(agents(), /15555550199/); // The owner's contact is not the assistant's number.
  const accountFile = path.join(workspace, 'phone/account.json');
  assert.ok(!readFileSync(accountFile, 'utf8').includes(key));
  assert.ok(!agents().includes(key));
  assert.equal(readFileSync(path.join(dir, 'config/openclaw.json'), 'utf8'), configBefore);
  assert.equal(readFileSync(path.join(dir, '.env'), 'utf8'), envBefore);
  renderTenant(tenant, fleet);
  assert.match(agents(), /\+15555550123/);

  // Authentication failures and invalid/ambiguous responses must not erase a known number.
  status = 401;
  await assert.rejects(syncPhoneAccount(tenant), /HTTP 401/);
  assert.match(agents(), /\+15555550123/);
  status = 200;
  for (const invalid of [{ error: 'unavailable' }, [{ phoneNumber: 'untrusted text' }],
    [{ phoneNumber: '+15555550123' }, { phoneNumber: '+15555550124' }]]) {
    result = invalid;
    await assert.rejects(syncPhoneAccount(tenant), /Unexpected phone number response/);
    assert.equal(JSON.parse(readFileSync(accountFile, 'utf8')).phoneNumber, '+15555550123');
  }

  // A verified release removes the old number from the next prompt.
  result = [];
  assert.equal(await syncPhoneAccount(tenant), null);
  assert.doesNotMatch(agents(), /\+15555550123/);
  result = [{ phoneNumber: '+15555550124' }];
  await syncPhoneAccount(tenant);
  assert.match(agents(), /\+15555550124/);
  tenant.capabilities.phone = { enabled: false };
  renderTenant(tenant, fleet);
  assert.doesNotMatch(agents(), /\+15555550124|BOTH calls and SMS/);
  assert.match(agents().split('## What you can offer to unlock')[1], /\*\*Text messaging \(SMS\)\*\*/);
  await assert.rejects(syncPhoneAccount(tenant), /Phone capability must be enabled/);
});

test('the nudge engine does not sell SMS to a phone-enabled tenant', () => {
  const tenant: Tenant = {
    id: 'phone-nudges', name: 'Phone Nudges', contact: {}, channel: 'whatsapp',
    gatewayPort: 29995, createdAt: new Date().toISOString(), nudgeLog: [],
    capabilities: { email: { enabled: true }, calendar: { enabled: true },
      phone: { enabled: true }, sms: { enabled: false }, webdev: { enabled: true } },
  };
  assert.equal(pickNudge(tenant)?.kind, 'deepen');
  tenant.capabilities.phone = { enabled: false };
  assert.equal(pickNudge(tenant)?.id, 'offer:sms');
});
