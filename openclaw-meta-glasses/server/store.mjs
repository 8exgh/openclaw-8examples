import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { httpError } from './security.mjs';

export class Store {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT NOT NULL, username TEXT NOT NULL, claw_id TEXT NOT NULL, text TEXT NOT NULL,
        credential TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL,
        PRIMARY KEY(username,id)
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, claw_id TEXT NOT NULL,
        username TEXT, kind TEXT NOT NULL, text TEXT NOT NULL, summary TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, username TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
        credential TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        event_seq INTEGER REFERENCES events(seq), device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
        apns_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
        PRIMARY KEY(event_seq,device_id)
      );
      CREATE INDEX IF NOT EXISTS events_claw ON events(claw_id,seq);
      CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status,created_at);`);
  }
  close() { this.db.close(); }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  enqueue({ id, username, clawId, text, credential }) {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM jobs WHERE username=? AND id=?').get(username, id);
      if (existing) {
        if (existing.claw_id !== clawId || existing.text !== text) throw httpError(409, 'Request id already used for different content');
        if (existing.status === 'queued') this.db.prepare('UPDATE jobs SET credential=? WHERE username=? AND id=?').run(credential, username, id);
        return { requestId: id, status: existing.status };
      }
      const { count } = this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE username=? AND status IN ('queued','running')").get(username);
      if (count >= 10) throw httpError(429, 'Wait for your current requests to finish');
      this.db.prepare('INSERT INTO jobs(id,username,claw_id,text,credential,created_at) VALUES(?,?,?,?,?,?)')
        .run(id, username, clawId, text, credential, Date.now());
      return { requestId: id, status: 'queued' };
    });
  }
  claim() {
    return this.transaction(() => {
      const job = this.db.prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at,rowid LIMIT 1").get();
      if (job) this.db.prepare("UPDATE jobs SET status='running' WHERE username=? AND id=?").run(job.username, job.id);
      return job;
    });
  }
  finish(job, kind, text, summary) {
    return this.transaction(() => {
      const event = this.append({ eventId: `job:${job.username}:${job.id}`, clawId: job.claw_id,
        username: job.username, kind, text, summary });
      this.db.prepare('UPDATE jobs SET status=?,credential=? WHERE username=? AND id=?')
        .run(kind, '', job.username, job.id);
      return event;
    });
  }
  recoverInterrupted() {
    const jobs = this.db.prepare("SELECT * FROM jobs WHERE status='running'").all();
    for (const job of jobs) this.finish(job, 'uncertain',
      'The connection ended while OpenClaw was working. Check what it completed before repeating the request.',
      'A request was interrupted. Its outcome needs checking; it was not repeated.');
    return jobs.length;
  }
  append({ eventId, clawId, username = null, kind, text, summary }) {
    const old = this.db.prepare('SELECT * FROM events WHERE event_id=?').get(eventId);
    if (old) {
      if (old.claw_id !== clawId || old.username !== username || old.kind !== kind || old.text !== text || old.summary !== summary) {
        throw httpError(409, 'Summary id already used for different content');
      }
      return old;
    }
    const now = Date.now();
    const { lastInsertRowid } = this.db.prepare('INSERT INTO events(event_id,claw_id,username,kind,text,summary,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(eventId, clawId, username, kind, text, summary, now);
    // Ownership is checked again against the account service before every push.
    const devices = username === null ? this.db.prepare('SELECT id FROM devices').all()
      : this.db.prepare('SELECT id FROM devices WHERE username=?').all(username);
    for (const device of devices) this.db.prepare('INSERT INTO outbox(event_seq,device_id,apns_id,next_at) VALUES(?,?,?,?)')
      .run(lastInsertRowid, device.id, randomUUID(), now);
    return this.db.prepare('SELECT * FROM events WHERE seq=?').get(lastInsertRowid);
  }
  events(username, clawId, after) {
    const rows = after === undefined
      ? this.db.prepare('SELECT * FROM events WHERE claw_id=? AND (username IS NULL OR username=?) ORDER BY seq DESC LIMIT 100').all(clawId, username).reverse()
      : this.db.prepare('SELECT * FROM events WHERE claw_id=? AND (username IS NULL OR username=?) AND seq>? ORDER BY seq LIMIT 100').all(clawId, username, after);
    return { events: rows.map((e) => ({ seq: e.seq, id: e.event_id, clawId: e.claw_id, kind: e.kind,
      text: e.text, summary: e.summary, createdAt: e.created_at })), cursor: rows.at(-1)?.seq ?? after ?? 0 };
  }
  registerDevice({ id, username, token, credential }) {
    this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM devices WHERE id=?').get(id);
      if (old?.username === username && old.token === token) {
        // Refreshing login/foreground registration must preserve pending summaries.
        this.db.prepare('UPDATE devices SET credential=?,created_at=? WHERE id=?').run(credential, Date.now(), id);
        return;
      }
      // Reinstall/account switch replaces the previous subscription.
      this.db.prepare('DELETE FROM devices WHERE id=? OR token=?').run(id, token);
      this.db.prepare('INSERT INTO devices VALUES(?,?,?,?,?)').run(id, username, token, credential, Date.now());
    });
  }
  removeDevice(id, username) { this.db.prepare('DELETE FROM devices WHERE id=? AND username=?').run(id, username); }
  removeSessionDevice(id, username, token, vault) {
    const device = this.db.prepare('SELECT credential FROM devices WHERE id=? AND username=?').get(id, username);
    if (device && vault.open(device.credential) === token) {
      this.db.prepare('DELETE FROM devices WHERE id=? AND username=? AND credential=?').run(id, username, device.credential);
    }
  }
  deviceIsCurrent(item) {
    return !!this.db.prepare('SELECT 1 FROM devices WHERE id=? AND username=? AND token=? AND credential=?')
      .get(item.device_id, item.device_username, item.token, item.credential);
  }
  pendingPushes() {
    return this.db.prepare(`SELECT o.*, d.username AS device_username, d.token, d.credential,
      e.claw_id, e.username AS event_username, e.summary, e.created_at
      FROM outbox o JOIN devices d ON d.id=o.device_id JOIN events e ON e.seq=o.event_seq
      WHERE o.next_at<=? ORDER BY o.next_at LIMIT 50`).all(Date.now());
  }
  pushDone(item) { this.db.prepare('DELETE FROM outbox WHERE event_seq=? AND device_id=?').run(item.event_seq, item.device_id); }
  pushRetry(item) {
    if (item.attempts >= 5) return this.pushDone(item);
    this.db.prepare('UPDATE outbox SET attempts=attempts+1,next_at=? WHERE event_seq=? AND device_id=?')
      .run(Date.now() + Math.min(3600_000, 30_000 * 2 ** item.attempts), item.event_seq, item.device_id);
  }
}
