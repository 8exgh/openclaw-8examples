import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';

// A changed owner must not re-import the prior owner's records even if an
// operator keeps the same gateway credential during reassignment.
export function bindOwner(file, owner, now = Date.now()) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file); chmodSync(file, 0o600);
  try {
    db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, since TEXT NOT NULL); BEGIN IMMEDIATE;');
    const prior = db.prepare('SELECT owner,since FROM binding WHERE id=1').get();
    const since = prior && prior.owner !== owner ? new Date(now).toISOString() : prior?.since || '1970-01-01T00:00:00.000Z';
    db.prepare('INSERT INTO binding VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,since=excluded.since').run(owner, since);
    db.exec('COMMIT'); return since;
  } finally { db.close(); }
}

export function openInbox(file) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const read = (table, id) => {
    const row = db.prepare(`SELECT body FROM ${table} WHERE id=?`).get(id);
    return row ? JSON.parse(row.body) : undefined;
  };
  return {
    get: id => read('calls', id),
    list: () => db.prepare('SELECT body FROM calls').all().map(row => JSON.parse(row.body)).sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    insert: call => Boolean(db.prepare('INSERT OR IGNORE INTO calls VALUES (?,?)').run(call.id, JSON.stringify(call)).changes),
    update(id, mutate) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const call = read('calls', id);
        if (!call) throw new Error('Call not found in this Claw’s inbox');
        mutate(call);
        db.prepare('UPDATE calls SET body=? WHERE id=?').run(JSON.stringify(call), id);
        db.exec('COMMIT');
        return call;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    attempt: id => read('attempts', id),
    claim: (id, value) => Boolean(db.prepare('INSERT OR IGNORE INTO attempts VALUES (?,?)').run(id, JSON.stringify(value)).changes),
    finish: (id, value) => db.prepare('UPDATE attempts SET body=? WHERE id=?').run(JSON.stringify(value), id),
    metadata(key, initial) {
      if (initial !== undefined) db.prepare('INSERT OR IGNORE INTO metadata VALUES (?,?)').run(key, initial);
      return db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value;
    },
    setMetadata: (key, value) => db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value),
    close: () => db.close(),
  };
}
