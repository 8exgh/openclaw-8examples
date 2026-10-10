import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { composeUp } from '../src/provisioner/docker.js';
import type { Tenant } from '../src/types.js';

for (const scenario of ['reserve', 'running', 'migration-failure', 'health-failure']) {
  test(`activation: ${scenario}`, t => {
    const root = mkdtempSync(path.join(tmpdir(), 'activation-'));
    const old = { ...process.env };
    t.after(() => { process.env = old; rmSync(root, { recursive: true, force: true }); });
    process.env.PATH = root + ':' + old.PATH;
    process.env.MOC_TENANTS_DIR = root;
    process.env.ACTIVATION_TEST_LOG = path.join(root, 'calls');
    process.env.ACTIVATION_TEST_SCENARIO = scenario;
    mkdirSync(path.join(root, 'openclaw99'));
    writeFileSync(path.join(root, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$ACTIVATION_TEST_LOG"
if [ "$1" = ps ]; then
  if [ "$ACTIVATION_TEST_SCENARIO" = running ]; then printf 'Up 3 days (healthy)'; fi
fi
case "$*" in
  *'doctor --fix'*) [ "$ACTIVATION_TEST_SCENARIO" != migration-failure ] || exit 1;;
  *'--wait --wait-timeout'*) [ "$ACTIVATION_TEST_SCENARIO" != health-failure ] || exit 1;;
esac
`, { mode: 0o755 });
    const tenant = { id: 'openclaw99', tier: 'container' } as Tenant;
    if (scenario.endsWith('failure')) assert.throws(() => composeUp(tenant, ['@openclaw/moonshot-provider']));
    else composeUp(tenant, ['@openclaw/moonshot-provider']);
    const calls = readFileSync(process.env.ACTIVATION_TEST_LOG!, 'utf8').trim().split('\n');
    if (scenario === 'running') assert(!calls.some(call => call.includes('doctor')));
    else {
      const doctor = calls.findIndex(call => call.includes('doctor --fix --non-interactive'));
      assert(doctor > calls.indexOf('compose stop'));
      if (scenario === 'migration-failure') assert(!calls.some(call => call.startsWith('compose up')));
      else {
        assert(doctor < calls.findIndex(call => call.includes('plugins install')));
        assert(doctor < calls.findIndex(call => call.startsWith('compose up')));
      }
    }
    if (scenario !== 'migration-failure') assert.equal(calls.at(-1), 'compose up -d --wait --wait-timeout 120');
  });
}
