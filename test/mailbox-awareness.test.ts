import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { renderTenant } from '../src/provisioner/render.js';
import type { Fleet, Tenant } from '../src/types.js';

const fleet: Fleet = { releaseChannel: 'latest', image: 'test/image:latest', nextPort: 1 };

test('provisioned mailbox addresses are named in the always-loaded AGENTS.md', () => {
  const id = `test-mailbox-${Date.now()}`;
  const tenant: Tenant = {
    id, name: id, contact: {}, channel: 'telegram', gatewayPort: 29996,
    tier: 'container', createdAt: new Date().toISOString(), modelAccess: 'assigned',
    capabilities: { email: { enabled: true, enabledAt: new Date().toISOString() } }, nudgeLog: [],
  };
  const dir = path.join(process.cwd(), 'tenants', id);
  const workspace = path.join(dir, 'workspace');
  const agents = path.join(workspace, 'AGENTS.md');
  try {
    // First render with no mailbox yet: the email line names no accounts.
    renderTenant(tenant, fleet);
    assert.ok(!readFileSync(agents, 'utf8').includes('Live mailboxes'), 'no mailbox block before provisioning');

    // The mailbox provisioner delivers mailbox.md into the workspace out-of-band.
    mkdirSync(workspace, { recursive: true });
    writeFileSync(
      path.join(workspace, 'mailbox.md'),
      '- openclaw5@fusenv.com: mailboxes/openclaw5_fusenv_com.md\n' +
      '- wdolan@kalkiteenergy.com: mailboxes/wdolan_kalkiteenergy_com.md\n',
    );

    // Next render injects the live addresses into AGENTS.md so the agent is
    // aware of them without having to read mailbox.md first.
    renderTenant(tenant, fleet);
    const md = readFileSync(agents, 'utf8');
    assert.match(md, /Live mailboxes already connected/);
    assert.match(md, /openclaw5@fusenv\.com/);
    assert.match(md, /wdolan@kalkiteenergy\.com/);
    assert.match(md, /never say email isn't set up/);

    // Disabling email drops the block entirely.
    tenant.capabilities.email = { enabled: false };
    renderTenant(tenant, fleet);
    assert.ok(!readFileSync(agents, 'utf8').includes('Live mailboxes'), 'no mailbox block when email is off');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
