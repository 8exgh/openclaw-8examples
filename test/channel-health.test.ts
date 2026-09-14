import test from 'node:test';
import assert from 'node:assert/strict';
import { assertChannelTransports } from '../owner-state/channel-health.mjs';

const config = { channels: { telegram: { enabled: true } } };
const ready = { accountId: 'default', configured: true, enabled: true, running: true, connected: true, lifecycle: 'ready', probe: { ok: true } };
const status = (account: Record<string, unknown>) => ({ channelAccounts: { telegram: [account] } });
test('configured-only health cannot pass live channel verification', () => {
  assert.throws(() => assertChannelTransports(config, { channels: { telegram: { configured: true } } }), /Missing live accounts/);
  for (const patch of [{ running: false }, { connected: false }, { lifecycle: 'blocked' }, { probe: undefined }, { probe: { ok: false } }]) {
    assert.throws(() => assertChannelTransports(config, status({ ...ready, ...patch })));
  }
  assert.equal(assertChannelTransports(config, status(ready)).length, 1);
});
test('every enabled account must be healthy, while owner-disabled accounts stay disabled', () => {
  const multi = { channels: { telegram: { enabled: true, accounts: { first: {}, second: {}, disabled: { enabled: false } } } } };
  assert.throws(() => assertChannelTransports(multi, status({ ...ready, accountId: 'first' })), /second/);
  assert.equal(assertChannelTransports(multi, { channelAccounts: { telegram: ['first', 'second'].map(accountId => ({ ...ready, accountId })) } }).length, 2);
  assert.deepEqual(assertChannelTransports({ channels: { telegram: { enabled: false } } }, {}), []);
});
