// Run only inside the qualified 2026.9.4 image, with its Gateway stopped.
// Use that release's own schema migration routine without Doctor's unrelated
// configuration, skill, or workspace repairs. The caller supplies a full backup.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
assert.equal(process.env.OPENCLAW_UPGRADE_OFFLINE, '1');
assert.equal(process.getuid(), 1000);
assert.equal(JSON.parse(readFileSync('/app/package.json', 'utf8')).version, '2026.9.4');
// This bundle/export is pinned by upgrade-canary's immutable release manifest.
const { C: ensureSchema, b: assertCanonicalSchema } = await import('/app/dist/openclaw-agent-db-fItexY2B.mjs');
const state = '/home/node/.openclaw';
const retained = ['openclaw.json', ...['AGENTS.md', 'SOUL.md', 'USER.md', 'HEARTBEAT.md', 'TOOLS.md'].map(file => `workspace/${file}`)];
const contents = file => existsSync(path.join(state, file)) ? readFileSync(path.join(state, file)) : null;
const original = new Map(retained.map(file => [file, contents(file)]));
const agents = path.join(state, 'agents');
for (const agentId of readdirSync(agents)) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(agentId)) continue;
  const file = path.join(agents, agentId, 'agent/openclaw-agent.sqlite');
  if (!existsSync(file)) continue;
  const db = new DatabaseSync(file);
  try {
    const counts = () => Object.fromEntries(['session_nodes', 'session_windows', 'transcript_events'].map(table => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
    const before = counts();
    ensureSchema(db, { agentId, path: file, env: process.env });
    assertCanonicalSchema(db, { agentId, pathname: file });
    const after = counts();
    assert.deepEqual(after, before, 'Schema repair must preserve session and transcript counts');
    assert.equal(Object.values(db.prepare('PRAGMA quick_check').get())[0], 'ok');
    console.log(JSON.stringify({ agentId, before, after, canonicalSchema: true, integrity: 'ok' }));
  } finally { db.close(); }
}
for (const [file, before] of original) assert.deepEqual(contents(file), before, `Owner file changed: ${file}`);
console.log('PASS: owner configuration, workspace instructions, sessions and transcripts preserved during schema repair.');
