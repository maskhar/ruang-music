import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SongRequest, Track, Status } from './types.ts';
export class Store {
  db: DatabaseSync;
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, data TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS requests_status_order ON requests(status,created_at);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth (state TEXT PRIMARY KEY, session_hash TEXT NOT NULL, verifier TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, reply TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, error TEXT NOT NULL DEFAULT '');`);
    // A crash after dispatch is ambiguous: never resend automatically.
    this.db.prepare("UPDATE outbox SET status='uncertain',error='Server berhenti ketika pengiriman berlangsung.' WHERE status='sending'").run();
  }
  get<T>(key: string): T | null { const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined; return row ? JSON.parse(row.value) : null; }
  set(key: string, value: unknown) { this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  add(tracks: Track[], person: { requester: string; source: 'web' | 'whatsapp'; senderId?: string; messageId?: string; groupId?: string }): SongRequest[] {
    const latest = this.db.prepare('SELECT MAX(created_at) value FROM requests').get() as { value: number | null }; const baseTime = Math.max(Date.now(), (latest.value || 0) + 1);
    return this.transaction(() => tracks.map((track, index) => { const request: SongRequest = { ...track, id: randomUUID(), ...person, senderId: person.senderId || '', messageId: person.messageId || '', groupId: person.groupId || '', status: 'queued', createdAt: baseTime + index, startedAt: null, positionMs: 0, error: '' }; this.save(request); return request; }));
  }
  save(request: SongRequest) { this.db.prepare('INSERT INTO requests(id,data,status,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,status=excluded.status').run(request.id, JSON.stringify(request), request.status, request.createdAt); }
  request(id: string): SongRequest | null { const r = this.db.prepare('SELECT data FROM requests WHERE id=?').get(id) as { data: string } | undefined; return r ? JSON.parse(r.data) : null; }
  list(status?: Status, limit = 200): SongRequest[] { const rows = status ? this.db.prepare('SELECT data FROM requests WHERE status=? ORDER BY created_at,rowid LIMIT ?').all(status, limit) : this.db.prepare("SELECT data FROM requests WHERE status NOT IN ('queued','starting','playing') ORDER BY created_at DESC LIMIT ?").all(limit); return rows.map(r => JSON.parse(r.data as string)); }
  active(): SongRequest | null { const id = this.get<string>('activeRequest'); return id ? this.request(id) : null; }
  cancelQueued(): number { return this.transaction(() => { const rows = this.list('queued', 1000); for (const r of rows) { r.status = 'cancelled'; this.save(r); } return rows.length; }); }
  confirmStarted(request: SongRequest) {
    this.transaction(() => { request.status = 'playing'; request.startedAt ||= Date.now(); this.save(request); if (request.source === 'whatsapp' && request.senderId) this.db.prepare("INSERT OR IGNORE INTO outbox(id,request_id,data,status,created_at) VALUES(?,?,?,'pending',?)").run(randomUUID(), request.id, JSON.stringify(request), Date.now()); });
  }
  close() { this.db.close(); }
}
