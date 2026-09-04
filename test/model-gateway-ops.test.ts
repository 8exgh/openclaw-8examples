import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Point the whole control plane at scratch dirs BEFORE importing anything that
// reads the store, and keep docker out of it.
const scratch = mkdtempSync(path.join(tmpdir(), 'moc-mgw-ops-'));
process.env.MOC_DATA_DIR = path.join(scratch, 'data');
process.env.MOC_TENANTS_DIR = path.join(scratch, 'tenants');
process.env.MOC_NO_START = '1';

const { modelCredentialsConverged, setFleetModelGateway, signup, syncModelAccess, verifyModelGateway } = await import('../src/ops.js');
const { loadFleet, saveFleet, tenantDir } = await import('../src/store.js');

test.after(() => rmSync(scratch, { recursive: true, force: true }));

// --- #1 reconciliation credential check ---
test('reconciliation treats a gateway tenant with its minted key as converged', () => {
  const gw = { modelGatewayUrl: 'http://model-gateway:8790' };
  const direct = {};

  // Assigned gateway tenant: the minted key alone satisfies it (no direct keys).
  assert.equal(modelCredentialsConverged(gw, 'assigned', 'MODEL_GATEWAY_KEY=mgw_openclaw1_abc\n'), true);
  // Without a real key it is NOT converged (still needs the mint).
  assert.equal(modelCredentialsConverged(gw, 'assigned', 'MODEL_GATEWAY_KEY=changeme\n'), false);
  assert.equal(modelCredentialsConverged(gw, 'assigned', ''), false);
  // A direct-wired tenant is unchanged: any real direct key satisfies it.
  assert.equal(modelCredentialsConverged(direct, 'assigned', 'KIMI_API_KEY=sk-kimi-real\n'), true);
  assert.equal(modelCredentialsConverged(direct, 'assigned', 'KIMI_API_KEY=changeme\n'), false);

  // Suppressed: BOTH the direct keys and the gateway key must be gone.
  assert.equal(modelCredentialsConverged(gw, 'suppressed', 'OPENCLAW_GATEWAY_TOKEN=x\n'), true);
  assert.equal(modelCredentialsConverged(gw, 'suppressed', 'MODEL_GATEWAY_KEY=mgw_x\n'), false);
  assert.equal(modelCredentialsConverged(direct, 'suppressed', 'KIMI_API_KEY=sk-real\n'), false);
});

// --- #2 fleet default is inherited at signup ---
test('new inventory inherits the fleet model-gateway default at signup', () => {
  setFleetModelGateway('http://model-gateway:8790');
  const before = signup({ name: 'GW One', id: 'gw-one' });
  assert.equal(before.tenant.modelGatewayUrl, 'http://model-gateway:8790');
  assert.equal(before.tenant.modelAccess, 'suppressed'); // fresh inventory, not consuming

  // Clearing the default means later signups do not inherit it.
  setFleetModelGateway(null);
  const after = signup({ name: 'GW Two', id: 'gw-two' });
  assert.equal(after.tenant.modelGatewayUrl, undefined);
});

// --- #2b adopt backfills existing tenants and records the fleet default ---
test('setFleetModelGateway --adopt backfills existing tenants', () => {
  setFleetModelGateway(null);
  signup({ name: 'Legacy', id: 'legacy-one' });
  const res = setFleetModelGateway('http://model-gateway:8790', { adopt: true });
  assert.equal(loadFleet().modelGatewayUrl, 'http://model-gateway:8790');
  assert.ok(res.adopted.includes('legacy-one'), 'existing tenant should be adopted');
});

// --- #1 end-to-end through syncModelAccess (suppressed branch: runtime is
//     satisfied by "not created", so `changed` isolates the credential check) ---
test('syncModelAccess flags a suppressed gateway tenant only if a key lingers', () => {
  saveFleet({ ...loadFleet(), modelGatewayUrl: 'http://model-gateway:8790' });
  signup({ name: 'Clean', id: 'sup-clean' }); // suppressed; key escrowed off .env
  signup({ name: 'Dirty', id: 'sup-dirty' });
  // Simulate a botched prior render that left the gateway key on a suppressed claw.
  const dirtyEnv = path.join(tenantDir('sup-dirty'), '.env');
  writeFileSync(dirtyEnv, readFileSync(dirtyEnv, 'utf8') + 'MODEL_GATEWAY_KEY=mgw_sup-dirty_leftover\n');

  const { changed } = syncModelAccess(new Set()); // everything suppressed
  assert.ok(!changed.includes('sup-clean'), 'a correctly-suppressed gateway tenant is not flagged');
  assert.ok(changed.includes('sup-dirty'), 'a suppressed tenant that still holds the gateway key IS flagged');
});

// --- #6 preflight verification of a tenant's gateway ---
test('verifyModelGateway passes on ok, fails on 401 / no-upstream / unreachable', async () => {
  const server = http.createServer((req, res) => {
    const key = req.headers['x-api-key'];
    if (key === 'good') { res.end(JSON.stringify({ ok: true, serving: 'opus-b' })); return; }
    if (key === 'no-upstream') { res.end(JSON.stringify({ ok: false, serving: '' })); return; }
    res.writeHead(401); res.end(JSON.stringify({ error: 'bad key' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as import('node:net').AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  try {
    assert.deepEqual(await verifyModelGateway(url, 'good'), { ok: true, serving: 'opus-b' });
    const bad = await verifyModelGateway(url, 'wrong');
    assert.equal(bad.ok, false);
    assert.match(bad.error!, /401/);
    const none = await verifyModelGateway(url, 'no-upstream');
    assert.equal(none.ok, false);
    assert.match(none.error!, /no usable upstream/);
  } finally {
    server.close();
  }
  // Unreachable gateway (nothing listening) fails, doesn't throw.
  const dead = await verifyModelGateway('http://127.0.0.1:9', 'good', { timeoutMs: 1500 });
  assert.equal(dead.ok, false);
});
