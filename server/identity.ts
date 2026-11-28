import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { decrypt, encrypt, hash, secret } from './crypto.ts';
import { AppError } from './types.ts';

export type Role = 'owner' | 'operator' | 'member';
export interface User { id: string; email: string; name: string; admin: boolean }
export interface Room { id: string; name: string; role: Role; groupId: string | null; ownerName: string }

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
  constructor(file: string, private bootstrapPassword: string, defaultGroups: string[], session = 'carubra', private encryptionKey = randomBytes(32).toString('hex')) {
    if (file !== ':memory:' && arguments.length < 5) throw new Error('ENCRYPTION_KEY diperlukan untuk penyimpanan kode verifikasi.');
    if (!/^[a-f0-9]{64}$/i.test(this.encryptionKey)) throw new Error('ENCRYPTION_KEY harus 64 karakter hex.');
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, password_hash TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS room_members (room_id TEXT NOT NULL REFERENCES rooms(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('owner','operator','member')), PRIMARY KEY(room_id,user_id));
      CREATE TABLE IF NOT EXISTS room_groups (group_id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), session TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS room_control_aliases (room_id TEXT NOT NULL REFERENCES rooms(id), group_id TEXT NOT NULL, session TEXT NOT NULL, alias TEXT NOT NULL, PRIMARY KEY(room_id,group_id,session,alias));
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS spotify_accounts (spotify_id TEXT PRIMARY KEY, room_id TEXT NOT NULL UNIQUE REFERENCES rooms(id));
      CREATE TABLE IF NOT EXISTS invitations (hash TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), email TEXT NOT NULL COLLATE NOCASE, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('operator','member')), expires INTEGER NOT NULL, UNIQUE(room_id,email));
      CREATE TABLE IF NOT EXISTS room_verifications (room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE, code_hash TEXT NOT NULL UNIQUE, code_ciphertext TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS command_receipts (id TEXT PRIMARY KEY, reply TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS room_members_user ON room_members(user_id);
      CREATE INDEX IF NOT EXISTS room_groups_room ON room_groups(room_id);`);
    const roomColumns = this.db.prepare('PRAGMA table_info(rooms)').all() as {name:string}[];
    if (!roomColumns.some(column => column.name === 'deleted_at')) this.db.exec('ALTER TABLE rooms ADD COLUMN deleted_at INTEGER');
    if (!(this.db.prepare('SELECT 1 FROM users LIMIT 1').get())) {
      const adminId = randomUUID();
      this.transaction(() => {
        this.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(adminId, 'owner@local', 'Pemilik', passwordHash(secret()), 1, Date.now());
        this.db.prepare('INSERT INTO rooms(id,name,owner_id,created_at) VALUES(?,?,?,?)').run('default', 'Ruang utama', adminId, Date.now());
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
    return this.db.prepare(`SELECT r.id,r.name,u.name ownerName,CASE WHEN ?=1 THEN 'owner' ELSE m.role END role,
      (SELECT group_id FROM room_groups WHERE room_id=r.id ORDER BY group_id LIMIT 1) groupId
      FROM rooms r JOIN users u ON u.id=r.owner_id LEFT JOIN room_members m ON m.room_id=r.id AND m.user_id=?
      WHERE r.deleted_at IS NULL AND (?=1 OR m.role IS NOT NULL) ORDER BY r.created_at,r.id`).all(+user.admin,user.id,+user.admin) as unknown as Room[];
  }
  listActiveRoomIds(): string[] {
    return this.db.prepare('SELECT id FROM rooms WHERE deleted_at IS NULL ORDER BY created_at,id').all().map(row => String(row.id));
  }
  isActiveRoom(roomId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM rooms WHERE id=? AND deleted_at IS NULL').get(roomId);
  }
  role(user: User, roomId: string): Role | null {
    if (user.admin && this.db.prepare('SELECT 1 FROM rooms WHERE id=? AND deleted_at IS NULL').get(roomId)) return 'owner';
    const row = this.db.prepare('SELECT m.role FROM room_members m JOIN rooms r ON r.id=m.room_id WHERE m.user_id=? AND m.room_id=? AND r.deleted_at IS NULL').get(user.id, roomId) as {role:Role}|undefined;
    return row?.role || null;
  }
  require(user: User, roomId: string, roles: Role[] = ['owner','operator','member']) {
    const role = this.role(user, roomId);
    if (!role || !roles.includes(role)) throw new AppError('Akses ruang ditolak.', 403);
    return role;
  }
  roomForGroup(group: string, session: string): string | null {
    const row = this.db.prepare('SELECT g.room_id roomId FROM room_groups g JOIN rooms r ON r.id=g.room_id WHERE g.group_id=? AND g.session=? AND r.deleted_at IS NULL').get(group, session) as {roomId:string}|undefined;
    return row?.roomId || null;
  }
  groupsForRoom(roomId: string, session: string) {
    return this.db.prepare('SELECT g.group_id FROM room_groups g JOIN rooms r ON r.id=g.room_id WHERE g.room_id=? AND g.session=? AND r.deleted_at IS NULL')
      .all(roomId,session).map(row => String(row.group_id));
  }
  controlAliases(roomId: string, groupId: string, session: string): string[] {
    return this.db.prepare(`SELECT a.alias FROM room_control_aliases a
      JOIN room_groups g ON g.room_id=a.room_id AND g.group_id=a.group_id AND g.session=a.session
      JOIN rooms r ON r.id=g.room_id
      WHERE a.room_id=? AND a.group_id=? AND a.session=? AND r.deleted_at IS NULL
      ORDER BY a.alias`).all(roomId,groupId,session).map(row => String(row.alias));
  }
  replaceControlAliases(actor: User, roomId: string, groupId: string, session: string, aliases: string[]): void {
    this.transaction(() => {
      this.require(actor,roomId,['owner']);
      const bound = this.db.prepare(`SELECT 1 FROM room_groups g JOIN rooms r ON r.id=g.room_id
        WHERE g.room_id=? AND g.group_id=? AND g.session=? AND r.deleted_at IS NULL`).get(roomId,groupId,session);
      if (!bound) throw new AppError('Grup tidak terhubung ke ruang ini.',409);
      const normalized = [...new Set(aliases.map(alias => alias.trim().toLowerCase()))];
      if (normalized.length !== aliases.length || normalized.some(alias => !/^[0-9]{1,24}@(c\.us|lid)$/.test(alias))) {
        throw new AppError('ID WhatsApp tidak valid atau duplikat.',400);
      }
      this.db.prepare('DELETE FROM room_control_aliases WHERE room_id=? AND group_id=? AND session=?').run(roomId,groupId,session);
      const insert = this.db.prepare('INSERT INTO room_control_aliases(room_id,group_id,session,alias) VALUES(?,?,?,?)');
      for (const alias of normalized) insert.run(roomId,groupId,session,alias);
    });
  }
  createRoom(owner: User, name: string) {
    const id = randomUUID();
    this.transaction(() => {
      this.db.prepare('INSERT INTO rooms(id,name,owner_id,created_at) VALUES(?,?,?,?)').run(id,name,owner.id,Date.now());
      this.db.prepare('INSERT INTO room_members VALUES(?,?,?)').run(id,owner.id,'owner');
      this.issueVerification(id);
    });
    return id;
  }
  private issueVerification(roomId: string) {
    const code = randomBytes(9).toString('hex');
    const expires = Date.now() + 10 * 60_000;
    this.db.prepare(`INSERT INTO room_verifications VALUES(?,?,?,?)
      ON CONFLICT(room_id) DO UPDATE SET code_hash=excluded.code_hash,code_ciphertext=excluded.code_ciphertext,expires=excluded.expires`)
      .run(roomId,hash(code),encrypt(code,this.encryptionKey),expires);
    return {code,expires};
  }
  verificationCode(actor: User, roomId: string) {
    this.require(actor,roomId,['owner','operator']);
    if (this.db.prepare('SELECT 1 FROM room_groups WHERE room_id=?').get(roomId)) return null;
    const row = this.db.prepare('SELECT code_ciphertext ciphertext,expires FROM room_verifications WHERE room_id=?').get(roomId) as {ciphertext:string;expires:number}|undefined;
    if (!row) return this.issueVerification(roomId);
    if (row.expires <= Date.now()) return null;
    return {code:decrypt<string>(row.ciphertext,this.encryptionKey),expires:row.expires};
  }
  regenerateVerificationCode(actor: User, roomId: string) {
    this.require(actor,roomId,['owner','operator']);
    if (this.db.prepare('SELECT 1 FROM room_groups WHERE room_id=?').get(roomId)) throw new AppError('Ruang ini sudah terhubung ke grup.',409);
    return this.issueVerification(roomId);
  }
  consumeVerification(groupId: string, session: string, code: string, allowRoom?: (roomId: string) => boolean) {
    return this.transaction(() => {
      const pairing = this.db.prepare(`SELECT v.room_id roomId,r.name roomName FROM room_verifications v
        JOIN rooms r ON r.id=v.room_id WHERE v.code_hash=? AND v.expires>? AND r.deleted_at IS NULL`).get(hash(code),Date.now()) as {roomId:string;roomName:string}|undefined;
      if (!pairing) throw new AppError('Kode verifikasi tidak valid atau kedaluwarsa.',409);
      if (allowRoom && !allowRoom(pairing.roomId)) throw new AppError('Ruang sedang dinonaktifkan.',409);
      if (this.db.prepare('SELECT 1 FROM room_groups WHERE room_id=?').get(pairing.roomId)) throw new AppError('Ruang ini sudah terhubung ke grup.',409);
      if (this.db.prepare('SELECT 1 FROM room_groups WHERE group_id=?').get(groupId)) throw new AppError('Grup sudah terhubung ke ruang lain.',409);
      this.db.prepare('INSERT INTO room_groups VALUES(?,?,?)').run(groupId,pairing.roomId,session);
      this.db.prepare('DELETE FROM room_verifications WHERE room_id=?').run(pairing.roomId);
      return {...pairing,groupId};
    });
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
      const invite = this.db.prepare('SELECT i.* FROM invitations i JOIN rooms r ON r.id=i.room_id WHERE i.hash=? AND i.expires>? AND r.deleted_at IS NULL')
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
      this.db.prepare('DELETE FROM room_control_aliases WHERE room_id=? AND group_id=?').run(roomId,groupId);
      if (!this.db.prepare('SELECT 1 FROM room_groups WHERE room_id=?').get(roomId)) this.issueVerification(roomId);
    });
  }
  deleteRoom(actor: User, roomId: string): void {
    this.require(actor,roomId,['owner']);
    this.transaction(() => {
      const result = this.db.prepare('UPDATE rooms SET deleted_at=? WHERE id=? AND deleted_at IS NULL').run(Date.now(),roomId);
      if (!result.changes) throw new AppError('Ruang tidak ditemukan atau sudah dihapus.',404);
      this.db.prepare('DELETE FROM invitations WHERE room_id=?').run(roomId);
      this.db.prepare('DELETE FROM room_verifications WHERE room_id=?').run(roomId);
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='group_pairings'").get()) {
        this.db.prepare('DELETE FROM group_pairings WHERE room_id=?').run(roomId);
      }
      this.db.prepare('DELETE FROM room_groups WHERE room_id=?').run(roomId);
      this.db.prepare('DELETE FROM room_control_aliases WHERE room_id=?').run(roomId);
      this.db.prepare('DELETE FROM spotify_accounts WHERE room_id=?').run(roomId);
      this.db.prepare('DELETE FROM room_members WHERE room_id=?').run(roomId);
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
  bindSpotify(roomId: string, spotifyId: string) {
    this.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM rooms WHERE id=? AND deleted_at IS NULL').get(roomId)) throw new AppError('Ruang tidak tersedia.',404);
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
