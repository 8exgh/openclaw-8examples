import assert from 'node:assert/strict';

// A configured channel or successful getMe call alone does not prove its
// listener is running. Require live per-account transport state after upgrades.
export function assertChannelTransports(config, status) {
  const verified = [];
  for (const [channel, settings] of Object.entries(config.channels || {})) {
    if (settings?.enabled !== true) continue;
    const expected = settings.accounts
      ? Object.entries(settings.accounts).filter(([, account]) => account.enabled !== false).map(([id]) => id)
      : [status.channelDefaultAccountId?.[channel] || 'default'];
    if (!expected.length) continue;
    const accounts = status.channelAccounts?.[channel];
    assert(Array.isArray(accounts) && accounts.length, `Missing live accounts for ${channel}`);
    for (const accountId of expected) {
      const account = accounts.find(a => a.accountId === accountId);
      assert.equal(account?.configured, true, `${channel}/${accountId} configured`);
      assert.equal(account?.enabled, true, `${channel}/${accountId} enabled`);
      assert.equal(account?.running, true, `${channel}/${accountId} listener running`);
      assert.notEqual(account?.lifecycle, 'blocked', `${channel}/${accountId} lifecycle blocked`);
      if (channel === 'telegram') {
        assert.equal(account.connected, true, 'Telegram transport connected');
        assert.equal(account.probe?.ok, true, 'Telegram API probe succeeds');
      } else assert.notEqual(account.probe?.ok, false, `${channel}/${accountId} probe failed`);
      verified.push({ channel, accountId, running: true, probeOk: account.probe?.ok });
    }
  }
  return verified;
}
