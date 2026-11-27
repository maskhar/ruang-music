import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { hash, secret } from './crypto.ts';
import { AppError } from './types.ts';

export type Role = 'owner' | 'operator' | 'member';
export interface User { id: string; email: string; name: string; admin: boolean }
export interface Room { id: string; name: string; role: Role; groupId: string | null }

function passwordHash(password: string, salt = randomBytes(16).toString('hex')) {
  return salt + ':' + scryptSync(password, salt, 64).toString('hex');
}
function verifyPassword(password: string, stored: string) {
  const [salt, digest] = stored.split(':');
  if (!salt || !digest || !/^[a-f0-9]{128}$/.test(digest)) return false;
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(digest, 'hex'));
}
export class Identity {
  db: DatabaseSync;
  constructor(file: string, private bootstrapPassword: string, defaultGroups: string[], session = 'carubra') {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, password_hash TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS room_members (room_id TEXT NOT NULL REFERENCES rooms(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('owner','operator','member')), PRIMARY KEY(room_id,user_id));
      CREATE TABLE IF NOT EXISTS room_groups (group_id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), session TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS spotify_accounts (spotify_id TEXT PRIMARY KEY, room_id TEXT NOT NULL UNIQUE REFERENCES rooms(id));
      CREATE TABLE IF NOT EXISTS invitations (hash TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), email TEXT NOT NULL COLLATE NOCASE, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('operator','member')), expires INTEGER NOT NULL, UNIQUE(room_id,email));
      CREATE TABLE IF NOT EXISTS group_pairings (hash TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), group_id TEXT NOT NULL UNIQUE, session TEXT NOT NULL, expires INTEGER NOT NULL, previous_room TEXT);
      CREATE TABLE IF NOT EXISTS command_receipts (id TEXT PRIMARY KEY, reply TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS room_members_user ON room_members(user_id);
      CREATE INDEX IF NOT EXISTS room_groups_room ON room_groups(room_id);`);
    if (!(this.db.prepare('SELECT 1 FROM users LIMIT 1').get())) {
      const adminId = randomUUID();
      this.transaction(() => {
        this.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(adminId, 'owner@local', 'Pemilik', passwordHash(secret()), 1, Date.now());
        this.db.prepare('INSERT INTO rooms VALUES(?,?,?,?)').run('default', 'Ruang utama', adminId, Date.now());
        this.db.prepare('INSERT INTO room_members VALUES(?,?,?)').run('default', adminId, 'owner');
        for (const group of defaultGroups.filter(group => group !== '0@g.us')) this.db.prepare('INSERT INTO room_groups VALUES(?,?,?)').run(group, 'default', session);
      });
    }
  }
  login(email: string, password: string) {
    const row = this.db.prepare('SELECT * FROM users WHERE email=?').get(email.toLowerCase()) as any;
    const valid = row?.admin ? verifyPassword(password, passwordHash(this.bootstrapPassword, 'ruang-musik-admin')) :
      verifyPassword(password, row?.password_hash || 'unknown:' + '0'.repeat(128));
    if (!row || !valid) throw new AppError('Email atau password salah.', 401);
    const token = secret();
    this.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token), row.id, Date.now() + 7 * 86400000);
    return { token, user: this.publicUser(row) };
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  publicUser(row: any): User { return { id: row.id, email: row.email, name: row.name, admin: !!row.admin }; }
  session(token: string): User | null {
    if (!token) return null;
    const row = this.db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>?').get(hash(token), Date.now());
    return row ? this.publicUser(row) : null;
  }
  logout(token: string) { this.db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(token)); }
  rooms(user: User): Room[] {
    return this.db.prepare(`SELECT r.id,r.name,CASE WHEN ?=1 THEN 'owner' ELSE m.role END role,
      (SELECT group_id FROM room_groups WHERE room_id=r.id ORDER BY group_id LIMIT 1) groupId
      FROM rooms r LEFT JOIN room_members m ON m.room_id=r.id AND m.user_id=?
      WHERE ?=1 OR m.role IS NOT NULL ORDER BY r.created_at,r.id`).all(+user.admin,user.id,+user.admin) as unknown as Room[];
  }
  role(user: User, roomId: string): Role | null {
    if (user.admin && this.db.prepare('SELECT 1 FROM rooms WHERE id=?').get(roomId)) return 'owner';
    const row = this.db.prepare('SELECT role FROM room_members WHERE user_id=? AND room_id=?').get(user.id, roomId) as {role:Role}|undefined;
    return row?.role || null;
  }
  require(user: User, roomId: string, roles: Role[] = ['owner','operator','member']) {
    const role = this.role(user, roomId);
    if (!role || !roles.includes(role)) throw new AppError('Akses ruang ditolak.', 403);
    return role;
  }
  roomForGroup(group: string, session: string): string | null {
    const row = this.db.prepare('SELECT room_id roomId FROM room_groups WHERE group_id=? AND session=?').get(group, session) as {roomId:string}|undefined;
    return row?.roomId || null;
  }
  createRoom(owner: User, name: string) {
    const id = randomUUID();
    this.transaction(() => {
      this.db.prepare('INSERT INTO rooms VALUES(?,?,?,?)').run(id,name,owner.id,Date.now());
      this.db.prepare('INSERT INTO room_members VALUES(?,?,?)').run(id,owner.id,'owner');
    });
    return id;
  }
  invite(actor: User, roomId: string, email: string, name: string, role: Exclude<Role,'owner'>) {
    this.require(actor,roomId,['owner']);
    const existing = this.db.prepare('SELECT id FROM users WHERE email=?').get(email) as {id:string}|undefined;
    if (existing) { this.addMember(actor,roomId,existing.id,role); return null; }
    const token = secret();
    this.db.prepare(`INSERT INTO invitations VALUES(?,?,?,?,?,?) ON CONFLICT(room_id,email)
      DO UPDATE SET hash=excluded.hash,name=excluded.name,role=excluded.role,expires=excluded.expires`)
      .run(hash(token),roomId,email,name,role,Date.now() + 86400000);
    return token;
  }
  accept(token: string, password: string) {
    return this.transaction(() => {
      const invite = this.db.prepare('SELECT * FROM invitations WHERE hash=? AND expires>?')
        .get(hash(token),Date.now()) as {room_id:string; email:string; name:string; role:Exclude<Role,'owner'>}|undefined;
      if (!invite) throw new AppError('Undangan tidak valid atau kedaluwarsa.',410);
      if (this.db.prepare('SELECT 1 FROM users WHERE email=?').get(invite.email)) {
        throw new AppError('Email sudah punya akun. Minta pemilik menambahkan akun yang sudah ada.',409);
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id,invite.email,invite.name,passwordHash(password),0,Date.now());
      this.db.prepare('INSERT INTO room_members VALUES(?,?,?)').run(invite.room_id,id,invite.role);
      this.db.prepare('DELETE FROM invitations WHERE hash=?').run(hash(token));
      return invite.email;
    });
  }
  addMember(actor: User, roomId: string, userId: string, role: Exclude<Role,'owner'>) {
    this.require(actor, roomId, ['owner']);
    const result = this.db.prepare(`INSERT INTO room_members(room_id,user_id,role) VALUES(?,?,?) ON CONFLICT(room_id,user_id) DO UPDATE SET role=excluded.role WHERE room_members.role!='owner'`).run(roomId,userId,role);
    if (!result.changes) throw new AppError('Pemilik ruang tidak dapat diganti.', 409);
  }
  members(actor: User, roomId: string) {
    this.require(actor,roomId,['owner']);
    return this.db.prepare(`SELECT u.id,u.name,u.email,m.role FROM room_members m
      JOIN users u ON u.id=m.user_id WHERE m.room_id=? ORDER BY m.role='owner' DESC,u.name`).all(roomId);
  }
  removeMember(actor: User, roomId: string, userId: string) {
    this.require(actor,roomId,['owner']);
    const result = this.db.prepare("DELETE FROM room_members WHERE room_id=? AND user_id=? AND role<>'owner'").run(roomId,userId);
    if (!result.changes) throw new AppError('Anggota tidak ditemukan atau merupakan pemilik ruang.',409);
  }
  unbindGroup(actor: User, roomId: string, groupId: string) {
    this.require(actor,roomId,['owner']);
    this.transaction(() => {
      const result = this.db.prepare('DELETE FROM room_groups WHERE room_id=? AND group_id=?').run(roomId,groupId);
      if (!result.changes) throw new AppError('Grup tidak terhubung ke ruang ini.',409);
      this.db.prepare('DELETE FROM group_pairings WHERE group_id=?').run(groupId);
    });
  }
  beginPairing(actor: User, roomId: string, groupId: string, session: string) {
    this.require(actor,roomId,['owner']);
    const previous = this.roomForGroup(groupId,session);
    if (previous && previous !== roomId && (previous !== 'default' || this.role(actor,previous) !== 'owner')) {
      throw new AppError('Grup sudah terhubung ke ruang lain.',409);
    }
    if (this.db.prepare('SELECT 1 FROM room_groups WHERE room_id=? AND group_id<>?').get(roomId,groupId)) {
      throw new AppError('Ruang ini sudah terhubung dengan grup lain.',409);
    }
    const code = randomBytes(9).toString('hex');
    this.db.prepare(`INSERT INTO group_pairings VALUES(?,?,?,?,?,?) ON CONFLICT(group_id)
      DO UPDATE SET hash=excluded.hash,room_id=excluded.room_id,session=excluded.session,expires=excluded.expires,previous_room=excluded.previous_room`)
      .run(hash(code),roomId,groupId,session,Date.now()+600000,previous);
    return code;
  }
  finishPairing(groupId: string, session: string, code: string) {
    return this.transaction(() => {
      const pairing = this.db.prepare('SELECT * FROM group_pairings WHERE hash=? AND group_id=? AND session=? AND expires>?')
        .get(hash(code),groupId,session,Date.now()) as {room_id:string; previous_room:string|null}|undefined;
      if (!pairing || this.roomForGroup(groupId,session) !== pairing.previous_room) {
        throw new AppError('Kode pemasangan tidak valid atau kedaluwarsa.',409);
      }
      if (this.db.prepare('SELECT 1 FROM room_groups WHERE room_id=? AND group_id<>?').get(pairing.room_id,groupId)) {
        throw new AppError('Ruang ini sudah terhubung dengan grup lain.',409);
      }
      this.db.prepare('INSERT INTO room_groups VALUES(?,?,?) ON CONFLICT(group_id) DO UPDATE SET room_id=excluded.room_id,session=excluded.session')
        .run(groupId,pairing.room_id,session);
      this.db.prepare('DELETE FROM group_pairings WHERE hash=?').run(hash(code));
      return pairing.room_id;
    });
  }
  beginCommand(id: string) {
    const inserted = this.db.prepare('INSERT OR IGNORE INTO command_receipts VALUES(?,?)')
      .run(id,'Command sudah diterima. Periksa /queue sebelum mencoba lagi.');
    if (inserted.changes) return null;
    return (this.db.prepare('SELECT reply FROM command_receipts WHERE id=?').get(id) as {reply:string}).reply;
  }
  saveReply(id: string, reply: string) {
    this.db.prepare('UPDATE command_receipts SET reply=? WHERE id=?').run(reply,id);
  }
  pairingReply(groupId: string, session: string, code: string, receiptId: string) {
    const prior = this.beginCommand(receiptId);
    if (prior) return {reply:prior,duplicate:true};
    let reply: string;
    let commandFailed = false;
    try {
      const roomId = this.finishPairing(groupId,session,code);
      const room = this.db.prepare('SELECT name FROM rooms WHERE id=?').get(roomId) as {name:string};
      reply = 'Grup berhasil dihubungkan ke ruang ' + room.name + '.';
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      reply = error.message;
      commandFailed = true;
    }
    this.saveReply(receiptId,reply);
    return {reply,commandFailed};
  }
  bindSpotify(roomId: string, spotifyId: string) {
    this.transaction(() => {
      const current = this.db.prepare('SELECT room_id FROM spotify_accounts WHERE spotify_id=?').get(spotifyId) as {room_id:string}|undefined;
      if (current && current.room_id !== roomId) throw new AppError('Akun Spotify sudah terhubung ke ruang lain.',409);
      this.db.prepare('DELETE FROM spotify_accounts WHERE room_id=?').run(roomId);
      this.db.prepare('INSERT INTO spotify_accounts VALUES(?,?)').run(spotifyId,roomId);
    });
  }
  spotifyId(roomId: string) {
    return (this.db.prepare('SELECT spotify_id FROM spotify_accounts WHERE room_id=?').get(roomId) as {spotify_id:string}|undefined)?.spotify_id;
  }
  close() { this.db.close(); }
}
