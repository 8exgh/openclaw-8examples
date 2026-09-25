import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderAgentInstructions, renderTenant } from '../src/provisioner/render.js';
import { adoptAgentBaselines } from '../src/ops.js';
import { adoptAgentBody, agentBaseline, agentBody, updateAgentBody } from '../owner-state/index.mjs';
import type { Tenant } from '../src/types.js';

const fleet = { releaseChannel: 'latest' as const, image: 'test/image', nextPort: 1 };
const ENABLED = '## What you can do right now';

function scratch(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-body-')), prior = process.env.MOC_TENANTS_DIR;
  process.env.MOC_TENANTS_DIR = root;
  t.after(() => {
    if (prior === undefined) delete process.env.MOC_TENANTS_DIR; else process.env.MOC_TENANTS_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function tenant(id: string, capabilities: Tenant['capabilities'] = {}): Tenant {
  return { id, name: id, contact: {}, channel: 'telegram', gatewayPort: 29900, tier: 'container', createdAt: new Date().toISOString(), capabilities, nudgeLog: [] };
}
const enabledSection = (file: string): string => {
  const text = readFileSync(file, 'utf8');
  return text.slice(text.indexOf(ENABLED), text.indexOf('## What you can offer to unlock'));
};

test('a workspace rendered before the ledger is kept, not frozen, until its baseline is adopted', (t) => {
  const root = scratch(t);
  const claw = tenant('slot1');
  renderTenant(claw, fleet);
  const dir = path.join(root, claw.id), file = path.join(dir, 'workspace/AGENTS.md'), ledger = path.join(dir, '.owner-state/agent-body.json');
  assert.ok(existsSync(ledger));
  rmSync(ledger); // what every inventory slot looked like before the ledger existed
  const inventoryBody = agentBody(dir)!;
  assert.doesNotMatch(enabledSection(file), /\*\*Email\*\*/);

  claw.capabilities = { email: { enabled: true, enabledAt: new Date().toISOString() } };
  renderAgentInstructions(claw); // the purchase: email switched on
  assert.doesNotMatch(enabledSection(file), /\*\*Email\*\*/, 'an unverified pre-ledger file is preserved');
  assert.equal(agentBaseline(dir), undefined, 'and no misleading baseline is recorded');
  assert.equal(updateAgentBody(dir, 'anything'), false);

  adoptAgentBody(dir, inventoryBody);
  renderAgentInstructions(claw);
  assert.match(enabledSection(file), /\*\*Email\*\*/, 'once the baseline is known the render refreshes the file');
  assert.equal(agentBaseline(dir), agentBody(dir));

  appendFileSync(file, '\nOwner instructions: keep it short.\n');
  claw.capabilities.phone = { enabled: true, enabledAt: new Date().toISOString() };
  renderAgentInstructions(claw);
  assert.match(readFileSync(file, 'utf8'), /keep it short/, 'owner edits still win afterwards');
});

test('fleet adoption recognises the shared inventory render and leaves everything else alone', (t) => {
  const root = scratch(t);
  const slots = ['slot1', 'slot2', 'slot3', 'slot4'].map((id) => tenant(id));
  for (const claw of slots) { renderTenant(claw, fleet); rmSync(path.join(root, claw.id, '.owner-state/agent-body.json')); }
  const edited = path.join(root, 'slot4/workspace/AGENTS.md');
  appendFileSync(edited, '\nOwner instructions: this is my computer.\n');
  const current = tenant('current', { email: { enabled: true, enabledAt: new Date().toISOString() } });
  renderTenant(current, fleet); // signed up after the ledger existed: nothing to adopt
  const all = [...slots, current];

  const dry = adoptAgentBaselines(all, { dryRun: true });
  assert.equal(dry.inventory?.shared, 3);
  assert.deepEqual(dry.results.map((r) => [r.tenant, r.action]), [
    ['slot1', 'adopted'], ['slot2', 'adopted'], ['slot3', 'adopted'], ['slot4', 'kept-unrecognized'], ['current', 'already-current'],
  ]);
  assert.ok(!existsSync(path.join(root, 'slot1/.owner-state/agent-body.json')), 'a dry run writes nothing');

  const real = adoptAgentBaselines(all);
  assert.deepEqual(real.results.map((r) => r.action), ['adopted', 'adopted', 'adopted', 'kept-unrecognized', 'already-current']);
  assert.equal(agentBaseline(path.join(root, 'slot1')), agentBody(path.join(root, 'slot1')));
  assert.equal(agentBaseline(path.join(root, 'slot4')), undefined);

  slots[0].capabilities = { email: { enabled: true, enabledAt: new Date().toISOString() } };
  const refreshed = adoptAgentBaselines(all, { only: ['slot1'], refresh: true });
  assert.deepEqual(refreshed.results, [{ tenant: 'slot1', action: 'refreshed' }]);
  assert.match(enabledSection(path.join(root, 'slot1/workspace/AGENTS.md')), /\*\*Email\*\*/);
  assert.match(readFileSync(edited, 'utf8'), /this is my computer/);

  assert.equal(adoptAgentBaselines([slots[3]]).inventory, null, 'too few untouched workspaces to recognise a render');
});
