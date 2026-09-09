import assert from 'node:assert/strict';
import test from 'node:test';
import plugin from './plugin/index.mjs';
test('other private peers, groups and other agents cannot access this owner’s call inbox', async () => {
  let hook, tool;
  plugin.register({
    config: {}, pluginConfig: { owner: { channel: 'telegram', peer: '777' } },
    runtime: { channel: { routing: { resolveAgentRoute: () => ({ agentId: 'main', sessionKey: 'agent:main:telegram:direct:777' }) } } },
    on: (_name, fn) => { hook = fn; }, registerTool: fn => { tool = fn; }, registerService() {},
  });
  for (const ctx of [{ agentId: 'main', sessionKey: 'agent:main:telegram:direct:888' }, { agentId: 'main', sessionKey: 'agent:main:telegram:group:-777' }, { agentId: 'other', sessionKey: 'agent:other:hook:phone' }]) {
    assert.equal(tool(ctx), null); assert.equal(await hook({ prompt: 'Show the calls' }, ctx), undefined);
  }
  assert.equal(tool({ agentId: 'main', sessionKey: 'agent:main:telegram:direct:777' }).name, 'phone_handoff');
  assert.equal(tool({ agentId: 'main', sessionKey: 'agent:main:hook:phone' }).name, 'phone_handoff');
});
