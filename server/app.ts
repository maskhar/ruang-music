import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { Store } from './database.ts';
import { Spotify, scopes } from './spotify.ts';
import { whatsappCommand } from './whatsapp.ts';
import { Queue } from './queue.ts';
import { SpotifyObserver } from './spotify-observer.ts';
import { Notifications } from './notifications.ts';
import { Identity, type Role, type User } from './identity.ts';
import { getWahaGroupParticipants, getWahaJoinInfo, getWahaParticipantAlias, inviteCodeFromUrl, joinWahaGroup, normalizeParticipantId, verifyWahaMessage, type IncomingMessage, type WahaJoinInfo, type WahaJoinStatus, type WahaParticipant } from './waha.ts';
import { equal, hash, secret } from './crypto.ts';
import { AppError, type SongRequest } from './types.ts';
import type { Config } from './config.ts';
export function createApp(config: Config, provided?: Store, services: {
  verifyPairingMessage?: (message: IncomingMessage) => Promise<boolean>;
  getJoinInfo?: (code: string) => Promise<WahaJoinInfo>;
  joinGroup?: (code: string, info: WahaJoinInfo) => Promise<WahaJoinStatus>;
  getGroupParticipants?: (groupId: string) => Promise<WahaParticipant[]>;
  getParticipantAlias?: (id: string, signal?: AbortSignal) => Promise<string | null>;
} = {}) {
  const store = provided || new Store(join(config.dataDir, 'player.sqlite')), spotify = new Spotify(config, store), queue = new Queue(store, spotify);
  const blockedGroups = new Set(['0@g.us', ...config.blockedGroupIds]);
  const bootstrapGroups = config.groupIds.filter(id => !blockedGroups.has(id));
  const identity = new Identity(provided ? ':memory:' : join(config.dataDir, 'identity.sqlite'), config.password, bootstrapGroups, config.wahaSession, config.encryptionKey);
  const verifyPairingMessage = services.verifyPairingMessage ?? (message => verifyWahaMessage(config,message));
  const getJoinInfo = services.getJoinInfo ?? (code => getWahaJoinInfo(config,code));
  const joinGroup = services.joinGroup ?? ((code,info) => joinWahaGroup(config,code,info));
  const getGroupParticipants = services.getGroupParticipants ?? (groupId => getWahaGroupParticipants(config,groupId));
  const getParticipantAlias = services.getParticipantAlias ?? ((id,signal) => getWahaParticipantAlias(config,id,signal));
  const verifyBoundMessages = !!(services.verifyPairingMessage || (config.wahaUrl && config.wahaKey));
  const notificationsFor = (roomId: string, roomStore: Store) => new Notifications(roomStore, config, groupId =>
    !blockedGroups.has(groupId) && identity.roomForGroup(groupId, config.wahaSession) === roomId);
  const notifications = notificationsFor('default', store);
  type Runtime = { id: string; name: string; store: Store; spotify: Spotify; queue: Queue; notifications: Notifications; observer: SpotifyObserver; integrationSerial?: Promise<void>; notificationTask?: Promise<void> };
  const runtimes = new Map<string, Runtime>();
  const retiringRooms = new Set<string>();
  const joiningRooms = new Set<string>();
  const joiningGroups = new Set<string>();
  function requireActiveRoom(id: string) {
    if (retiringRooms.has(id) || !identity.isActiveRoom(id)) throw new AppError('Ruang sudah dihapus atau sedang dihapus.',403);
  }
  const initial: Runtime = { id: 'default', name: 'Ruang utama', store, spotify, queue, notifications, observer: new SpotifyObserver(spotify) };
  if (identity.isActiveRoom('default')) runtimes.set('default',initial);
  else spotify.retire();
  const runtime = (id: string): Runtime => {
    requireActiveRoom(id);
    let value = runtimes.get(id);
    if (!value) {
      const room = identity.db.prepare('SELECT name FROM rooms WHERE id=?').get(id) as {name:string}|undefined;
      if (!room) throw new AppError('Ruang tidak ditemukan.',404);
      const roomStore = new Store(provided ? ':memory:' : join(config.dataDir, 'rooms', id + '.sqlite'));
      const roomSpotify = new Spotify(config, roomStore), roomQueue = new Queue(roomStore, roomSpotify);
      value = { id, name:room.name, store: roomStore, spotify: roomSpotify, queue: roomQueue, observer: new SpotifyObserver(roomSpotify), notifications: notificationsFor(id, roomStore) };
      runtimes.set(id, value);
      value.queue.on('change', () => broadcast(value!));
      value.observer.on('change', () => {
        if (!retiringRooms.has(id)) void value!.queue.reconcile(value!.observer.state).then(() => broadcast(value!)).catch(() => {});
      });
    }
    return value;
  };
  const app = express(), server = createServer(app), wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  const observer = initial.observer;
  const clients = new Map<string, { socket: WebSocket; token: string; roomId: string }>();
  const controllers: Role[] = ['owner','operator'];
  const roomCards = (user: User) => identity.rooms(user).map(room => {
    const rt = runtimes.get(room.id) ?? runtime(room.id);
    const playback = rt.queue.playback;
    const playerConnected = !!rt.queue.lease && Date.now() - rt.queue.lease.updatedAt <= 30000;
    const current = rt.queue.current();
    const isPlaying = playerConnected && current?.status === 'playing' && !playback.paused;
    const queuedCount = Number(rt.store.db.prepare("SELECT COUNT(*) AS count FROM requests WHERE status='queued'").get()?.count || 0);
    return {...room, spotifyConnected:rt.spotify.connected, playerConnected, isPlaying,
      currentTrack:current && isPlaying ? {title:current.title,artist:current.artist} : null, queuedCount};
  });
  app.disable('x-powered-by'); app.set('trust proxy', config.trustProxy);
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", 'https://sdk.scdn.co'], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'https://i.scdn.co', 'https://mosaic.scdn.co', 'https://image-cdn-ak.spotifycdn.com', 'https://image-cdn-fa.spotifycdn.com'], connectSrc: ["'self'", 'https://*.spotify.com', 'https://*.scdn.co', 'wss://*.spotify.com'], frameSrc: ['https://sdk.scdn.co', 'https://*.spotify.com'], mediaSrc: ["'self'", 'blob:', 'https://*.scdn.co', 'https://*.spotifycdn.com'], upgradeInsecureRequests: config.cookieSecure ? [] : null } }, crossOriginEmbedderPolicy: false, crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }, strictTransportSecurity: config.cookieSecure ? undefined : false }));
  const standardJson = express.json({limit:'16kb'});
  const controlsJson = express.json({limit:'48kb'});
  app.use((req,res,next) => {
    const largerPayload = req.method === 'PUT' && /^\/api\/rooms\/[^/]+\/whatsapp\/controls\/?$/i.test(req.path);
    (largerPayload ? controlsJson : standardJson)(req,res,next);
  },cookieParser());
  app.get('/healthz', (_req, res) => res.json({ ok: true, queueMode: 'application', rooms: true }));
  const userFor = (req: express.Request) => { const user = identity.session(req.cookies?.carubra_session || ''); if (!user) throw new AppError('Masuk terlebih dahulu.', 401); return user; };
  const roomFor = (req: express.Request, roles?: Role[]) => { const user = userFor(req), roomId = req.get('x-room-id') || 'default'; identity.require(user,roomId,roles); return runtime(roomId); };
  const auth: express.RequestHandler = (req, res, next) => { try { userFor(req); res.set('Cache-Control', 'no-store'); next(); } catch { res.status(401).json({ error: 'Masuk terlebih dahulu.' }); } };
  const sameOrigin: express.RequestHandler = (req, res, next) => { const origin = req.get('origin'); if (origin !== config.origin && !(process.env.NODE_ENV !== 'production' && origin === 'http://127.0.0.1:5173')) { res.status(403).json({ error: 'Origin tidak diizinkan.' }); return; } next(); };
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.path.startsWith('/integrations/')) return sameOrigin(req, res, next); next(); });
  app.get('/api/session', (req, res) => { const user = identity.session(req.cookies.carubra_session || ''); res.json({ authenticated: !!user, user, rooms: user ? roomCards(user) : [], appName: 'Ruang Musik', origin: config.origin }); });
  const loginLimit = rateLimit({ windowMs: 15 * 60000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Terlalu banyak percobaan login. Tunggu 15 menit.' } });
  app.post('/api/login', loginLimit, (req, res) => {
    const body = z.object({ email: z.string().email().or(z.literal('owner@local')).optional(), password: z.string().max(256) }).parse(req.body);
    const login = identity.login(body.email || 'owner@local', body.password);
    res.cookie('carubra_session', login.token, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: 7 * 86400000, path: '/' }).json({ ok: true, user: login.user });
  });
  app.post('/api/logout', auth, (req, res) => {
    const token = req.cookies.carubra_session;
    identity.logout(token);
    for (const [id, client] of clients) if (client.token === token) {
      runtimes.get(client.roomId)?.queue.release(id);
      client.socket.close(1008, 'Signed out');
    }
    res.clearCookie('carubra_session', { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' }).json({ ok: true });
  });
  app.get('/api/rooms', auth, (req, res) => res.json({ rooms: roomCards(userFor(req)) }));
  app.post('/api/rooms', auth, (req, res) => { const name = z.string().trim().min(2).max(80).regex(/^[^\r\n]+$/).parse(req.body.name); const id = identity.createRoom(userFor(req),name); res.status(201).json({id,name}); });
  app.delete('/api/rooms/:id', auth, async (req,res) => {
    const user = userFor(req), id = String(req.params.id);
    identity.require(user,id,['owner']);
    if (joiningRooms.has(id)) throw new AppError('Tunggu sampai proses bergabung ke WhatsApp selesai.',409);
    const rt = runtime(id);
    retiringRooms.add(id);
    try {
      await rt.integrationSerial;
      await rt.queue.run(async () => {
        const lease = rt.queue.lease;
        if (!lease || Date.now() - lease.updatedAt > 30000) return;
        // Target only the SDK device that belongs to this room.
        await rt.spotify.api('/me/player/pause?device_id=' + encodeURIComponent(lease.deviceId),'PUT').catch(() => {});
      });
      await rt.notificationTask;
      identity.deleteRoom(user,id);
      rt.observer.stop();
      rt.spotify.retire();
      for (const [connectionId,client] of clients) {
        if (client.roomId !== id) continue;
        if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify({type:'room_deleted'}));
        client.socket.close(1008,'Ruang dihapus');
        rt.queue.release(connectionId);
        clients.delete(connectionId);
      }
      runtimes.delete(id);
      // SQLite data stays in place as an archive. The default store still serves legacy receipt deduplication.
      rt.queue.removeAllListeners();
      try {
        rt.store.transaction(() => {
          rt.store.db.exec("DELETE FROM oauth; DELETE FROM meta WHERE key IN ('spotifyTokens','spotifyAccount');");
        });
      } catch {
        console.error('Ruang sudah dihapus, tetapi pembersihan Spotify di arsip SQLite gagal.');
      } finally {
        if (id !== 'default') rt.store.close();
      }
      res.json({ok:true});
    } finally { retiringRooms.delete(id); }
  });
  app.get('/api/rooms/:id/members', auth, (req,res) => {
    requireActiveRoom(String(req.params.id));
    res.json({members:identity.members(userFor(req),String(req.params.id))});
  });
  app.post('/api/rooms/:id/members', auth, (req,res) => {
    requireActiveRoom(String(req.params.id));
    const body = z.object({ email:z.string().trim().email().max(254), name:z.string().trim().min(1).max(60), role:z.enum(['operator','member']) }).parse(req.body);
    const token = identity.invite(userFor(req),String(req.params.id),body.email.toLowerCase(),body.name,body.role);
    res.status(201).json({ inviteUrl: token ? config.origin + '/?invite=' + token : null });
  });
  app.post('/api/invitations/accept', loginLimit, (req,res) => {
    const body = z.object({token:z.string().regex(/^[a-zA-Z0-9_-]{43}$/),password:z.string().min(12).max(256)}).parse(req.body);
    const email = identity.accept(body.token, body.password);
    res.json({ok:true,email});
  });
  app.delete('/api/rooms/:id/members/:userId', auth, (req,res) => {
    const roomId = String(req.params.id), userId = String(req.params.userId);
    requireActiveRoom(roomId);
    identity.removeMember(userFor(req),roomId,userId);
    for (const [id,client] of clients) {
      if (client.roomId !== roomId || identity.session(client.token)?.id !== userId) continue;
      runtime(roomId).queue.release(id);
      client.socket.close(1008,'Akses ruang berakhir');
    }
    res.json({ok:true});
  });
  app.get('/api/rooms/:id/pairing', auth, (req,res) => {
    requireActiveRoom(String(req.params.id));
    const verification = identity.verificationCode(userFor(req),String(req.params.id));
    res.json({code:verification?.code ?? null,expiresAt:verification?.expires ?? null});
  });
  app.post('/api/rooms/:id/pairing', auth, (req,res) => {
    requireActiveRoom(String(req.params.id));
    const verification = identity.regenerateVerificationCode(userFor(req),String(req.params.id));
    res.status(201).json({code:verification.code,expiresAt:verification.expires});
  });
  const joinLimit = rateLimit({
    windowMs:10 * 60_000,
    limit:8,
    keyGenerator:req => userFor(req).id,
    legacyHeaders:false,
    message:{error:'Terlalu banyak percobaan bergabung. Coba lagi nanti.'}
  });
  const validateJoin: express.RequestHandler = (req,res,next) => {
    const roomId = String(req.params.id);
    requireUnpairedRoom(req,roomId);
    const inviteUrl = z.string().trim().min(1).max(512).parse(req.body?.inviteUrl);
    res.locals.joinCode = inviteCodeFromUrl(inviteUrl);
    next();
  };
  function requireUnpairedRoom(req: express.Request, roomId: string) {
    requireActiveRoom(roomId);
    identity.require(userFor(req),roomId,controllers);
    if (identity.groupsForRoom(roomId,config.wahaSession).length) throw new AppError('Lepaskan grup WhatsApp yang terhubung sebelum menggantinya.',409);
  }
  app.post('/api/rooms/:id/whatsapp/join',auth,validateJoin,joinLimit,async (req,res) => {
    const roomId = String(req.params.id), code = res.locals.joinCode as string;
    if (joiningRooms.has(roomId)) throw new AppError('Proses bergabung untuk ruang ini masih berjalan.',409);
    joiningRooms.add(roomId);
    try {
      const info = await getJoinInfo(code);
      requireUnpairedRoom(req,roomId);
      if (blockedGroups.has(info.groupId)) throw new AppError('Grup ini tidak tersedia untuk ruang development.',403);
      if (identity.roomForGroup(info.groupId,config.wahaSession)) throw new AppError('Grup ini sudah terhubung ke ruang lain.',409);
      if (joiningGroups.has(info.groupId)) throw new AppError('Carubra sedang memproses undangan untuk grup ini.',409);
      joiningGroups.add(info.groupId);
      try {
        const status = await joinGroup(code,info);
        requireUnpairedRoom(req,roomId);
        res.json({status,groupName:info.groupName});
      } finally { joiningGroups.delete(info.groupId); }
    } finally { joiningRooms.delete(roomId); }
  });
  app.delete('/api/rooms/:id/groups/:groupId', auth, (req,res) => {
    requireActiveRoom(String(req.params.id));
    identity.unbindGroup(userFor(req),String(req.params.id),String(req.params.groupId));
    res.json({ok:true});
  });
  function requireControlGroup(roomId: string, groupId: string) {
    requireActiveRoom(roomId);
    if (blockedGroups.has(groupId) || identity.roomForGroup(groupId,config.wahaSession) !== roomId) {
      throw new AppError('Grup WhatsApp ini belum terhubung ke ruang tersebut.',403);
    }
  }
  function requireControlManager(req: express.Request, roomId: string, groupId?: string) {
    const user = userFor(req);
    identity.require(user,roomId,['owner']);
    if (groupId) requireControlGroup(roomId,groupId);
    else requireActiveRoom(roomId);
    return user;
  }
  function matchesControlIdentity(roster: WahaParticipant[], id: string, alternate: string) {
    const matching = roster.filter(({aliases})=>aliases.includes(id) || aliases.includes(alternate));
    return matching.length > 0 && matching.every(({aliases})=>aliases.every(alias=>alias === id || alias === alternate));
  }
  const controlGroupId = z.string().regex(/^\d{1,30}@g\.us$/);
  app.get('/api/rooms/:id/whatsapp/control-groups',auth,(req,res) => {
    const roomId = String(req.params.id);
    requireControlManager(req,roomId);
    const groups = identity.groupsForRoom(roomId,config.wahaSession).filter(group => !blockedGroups.has(group));
    res.json({groups});
  });
  app.get('/api/rooms/:id/whatsapp/controls',auth,async (req,res) => {
    const roomId = String(req.params.id), groupId = controlGroupId.parse(req.query.groupId);
    requireControlManager(req,roomId,groupId);
    const roster = await getGroupParticipants(groupId);
    requireControlManager(req,roomId,groupId);
    const allowedIds = new Set(identity.controlAliases(roomId,groupId,config.wahaSession));
    const rosterIds = new Set(roster.flatMap(participant=>participant.aliases));
    const hasLids = [...rosterIds].some(id=>id.endsWith('@lid'));
    const hasPhones = [...rosterIds].some(id=>id.endsWith('@c.us'));
    const unmatched = [...allowedIds].filter(id=>!rosterIds.has(id));
    const toResolve = unmatched.filter(id=>id.endsWith('@lid') ? hasPhones : hasLids);
    const resolved = new Map<string,string>();
    const deadline = AbortSignal.timeout(6000);
    for (let index = 0; index < toResolve.length && !deadline.aborted; index += 8) {
      const batch = toResolve.slice(index,index+8);
      const alternates = await Promise.all(batch.map(id=>getParticipantAlias(id,deadline)));
      for (const [position,id] of batch.entries()) {
        const alternate = alternates[position];
        if (alternate && matchesControlIdentity(roster,id,alternate)) resolved.set(id,alternate);
      }
      requireControlManager(req,roomId,groupId);
    }
    const currentIds = identity.controlAliases(roomId,groupId,config.wahaSession);
    const allowedRosterIds = new Set(currentIds);
    for (const id of currentIds) {
      const alternate = resolved.get(id);
      if (alternate) allowedRosterIds.add(alternate);
    }
    res.json({groupId,unmatchedPermissions:currentIds.some(id=>!rosterIds.has(id) && !resolved.has(id)),participants:roster.map(({id,phone,aliases}) =>
      ({id,phone,allowed:aliases.some(alias=>allowedRosterIds.has(alias))}))});
  });
  app.put('/api/rooms/:id/whatsapp/controls',auth,async (req,res) => {
    const roomId = String(req.params.id);
    const {groupId,participantIds} = z.object({
      groupId:controlGroupId,
      participantIds:z.array(z.string().refine(id=>normalizeParticipantId(id) === id)).max(1024)
    }).parse(req.body);
    requireControlManager(req,roomId,groupId);
    const roster = participantIds.length ? await getGroupParticipants(groupId) : [];
    const actor = requireControlManager(req,roomId,groupId);
    const byId = new Map(roster.map(participant=>[participant.id,participant]));
    const aliases = new Set<string>();
    for (const id of new Set(participantIds)) {
      const participant = byId.get(id);
      if (!participant) throw new AppError('Daftar anggota berubah. Muat ulang anggota grup sebelum menyimpan.',409);
      for (const alias of participant.aliases) aliases.add(alias);
    }
    identity.replaceControlAliases(actor,roomId,groupId,config.wahaSession,[...aliases]);
    res.json({ok:true});
  });
  const publicRequest = (r: SongRequest | null) => { if (!r) return null; const { senderId: _sender, messageId: _message, groupId: _group, ...publicData } = r; return publicData; };
  const snapshot = (rt: Runtime) => ({ roomId:rt.id, current: publicRequest(rt.queue.current()), queue: rt.store.list('queued', 500).map(publicRequest), history: rt.store.list(undefined, 20).map(publicRequest), playback: rt.queue.playback, spotifyPlayback: rt.observer.state, notificationsFailed: Number((rt.store.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status IN ('failed','uncertain')").get() as any).count), spotifyConnected: rt.spotify.connected, spotifyConfigured: !!config.clientId, whatsappConfigured: !!(config.wahaKey && config.wahaUrl), callbackUrl: config.origin + '/auth/spotify/callback', origin: config.origin });
  const broadcast = (rt: Runtime) => {
    if (retiringRooms.has(rt.id) || !runtimes.has(rt.id)) return;
    const roomClients = [...clients.values()].filter(client => client.roomId === rt.id &&
      client.socket.readyState === WebSocket.OPEN && validClient(client.token,rt.id));
    if (!roomClients.length) return;
    const message = JSON.stringify({type:'snapshot',data:snapshot(rt)});
    for (const client of roomClients) client.socket.send(message);
  };
  queue.on('change', () => broadcast(initial));
  observer.on('change', () => {
    if (!retiringRooms.has('default')) void queue.reconcile(observer.state).then(() => broadcast(initial)).catch(() => {});
  });
  app.get('/api/state', auth, async (req, res) => { const rt=roomFor(req); await rt.observer.refresh(); roomFor(req); res.json(snapshot(rt)); });
  app.get('/auth/spotify', auth, (req, res) => {
    const roomId = z.string().uuid().or(z.literal('default')).parse(req.query.room || 'default');
    identity.require(userFor(req),roomId,controllers);
    const rt = runtime(roomId);
    if (!config.clientId) throw new AppError('Spotify belum dikonfigurasi.',409);
    const state = roomId + '.' + secret(), verifier = secret();
    rt.store.db.prepare('DELETE FROM oauth WHERE expires<?').run(Date.now());
    rt.store.db.prepare('INSERT INTO oauth(state,session_hash,verifier,expires) VALUES(?,?,?,?)')
      .run(state,hash(req.cookies.carubra_session),verifier,Date.now() + 600000);
    const params = new URLSearchParams({
      client_id:config.clientId,response_type:'code',redirect_uri:config.origin + '/auth/spotify/callback',
      code_challenge_method:'S256',code_challenge:rt.spotify.challenge(verifier),state,scope:scopes,
      // Each room can select a different Spotify account in the same browser.
      show_dialog:'true'
    });
    res.redirect('https://accounts.spotify.com/authorize?' + params);
  });
  app.get('/auth/spotify/callback', auth, async (req, res) => {
    const state = z.string().max(90).parse(req.query.state);
    const roomId = z.string().uuid().or(z.literal('default')).parse(state.split('.')[0]);
    identity.require(userFor(req),roomId,controllers);
    const rt = runtime(roomId);
    const row = rt.store.db.prepare('SELECT verifier FROM oauth WHERE state=? AND session_hash=? AND expires>?')
      .get(state,hash(req.cookies.carubra_session),Date.now()) as {verifier:string}|undefined;
    if (!row) throw new AppError('Sesi login Spotify kedaluwarsa. Ulangi Hubungkan Spotify.');
    rt.store.db.prepare('DELETE FROM oauth WHERE state=?').run(state);
    if (req.query.error) { res.redirect('/?room=' + roomId + '&spotify=denied'); return; }
    const {profile,encryptedTokens} = await rt.spotify.exchange(z.string().min(1).max(2048).parse(req.query.code),row.verifier);
    if (profile.product !== 'premium') throw new AppError('Akun Spotify Premium diperlukan.',403);
    requireActiveRoom(roomId);
    if (roomId !== 'default' && spotify.connected && !identity.spotifyId('default')) {
      if (retiringRooms.has('default')) throw new AppError('Tunggu sampai penghapusan Ruang utama selesai.',409);
      let legacyProfile;
      try { legacyProfile = await spotify.api('/me'); } catch {
        throw new AppError('Hubungkan ulang Spotify di Ruang utama sebelum menambah akun lain.',409);
      }
      if (typeof legacyProfile?.id !== 'string' || !legacyProfile.id) throw new AppError('Identitas Spotify Ruang utama belum tersedia.',409);
      if (identity.isActiveRoom('default') && !retiringRooms.has('default') && !identity.spotifyId('default')) identity.bindSpotify('default',legacyProfile.id);
    }
    identity.require(userFor(req),roomId,controllers);
    await rt.queue.run(async () => {
      requireActiveRoom(roomId);
      identity.require(userFor(req),roomId,controllers);
      if (rt.queue.lease && identity.spotifyId(roomId) !== profile.id) throw new AppError('Lepaskan player ruang sebelum mengganti akun Spotify.',409);
      rt.store.transaction(() => {
        const wasConnected = rt.spotify.connected;
        rt.store.set('spotifyTokens',encryptedTokens);
        rt.store.set('spotifyAccount',{id:profile.id,displayName:profile.display_name || 'Spotify',product:profile.product});
        if (!wasConnected) for (const groupId of identity.groupsForRoom(roomId,config.wahaSession)) {
          rt.notifications.enqueueSpotifyReady({groupId,roomName:rt.name,roomUrl:config.origin+'/?room='+roomId});
        }
        identity.bindSpotify(roomId,profile.id);
      });
    });
    broadcast(rt);
    res.redirect('/?room=' + roomId + '&spotify=connected');
  });
  app.get('/api/spotify/token', auth, async (req, res) => {
    const accessToken = await roomFor(req,controllers).spotify.token();
    roomFor(req,controllers);
    res.json({accessToken});
  });
  app.get('/api/search', auth, async (req, res) => {
    const tracks = await roomFor(req).spotify.search(z.string().trim().min(2).max(200).parse(req.query.q));
    roomFor(req);
    res.json({tracks});
  });
  app.post('/api/requests', auth, async (req, res) => {
    const rt = roomFor(req);
    const input = z.string().trim().min(1).max(500).parse(req.body.input);
    const tracks = await rt.spotify.resolve(input);
    roomFor(req);
    const added = await rt.queue.enqueue(tracks,{requester:userFor(req).name,source:'web'});
    res.status(201).json({added:added.length});
  });
  app.delete('/api/requests/:id', auth, async (req, res) => { await roomFor(req,['owner','operator']).queue.remove(String(req.params.id)); res.json({ ok: true }); });
  app.post('/api/queue/clear', auth, async (req, res) => { const cleared = await roomFor(req,['owner','operator']).queue.clear(); res.json({ cleared }); });
  const ownsConnection = (req: express.Request, room: Runtime, id: string) => {
    const client = clients.get(id);
    return client?.roomId === room.id && client.token === req.cookies.carubra_session && client.socket.readyState === WebSocket.OPEN;
  };
  app.post('/api/player/claim', auth, async (req, res) => {
    const rt = roomFor(req,controllers);
    const body = z.object({ connectionId:z.string().uuid(), deviceId:z.string().min(1).max(200), takeover:z.boolean().default(false) }).parse(req.body);
    if (!ownsConnection(req,rt,body.connectionId)) throw new AppError('Koneksi player tidak cocok dengan ruang ini.',409);
    const previous = rt.queue.lease?.connectionId, before = rt.queue.current()?.id;
    await rt.queue.claim(body.connectionId,body.deviceId,body.takeover);
    if (!ownsConnection(req,rt,body.connectionId) || !controllers.includes(validClient(req.cookies.carubra_session,rt.id) || 'member')) {
      rt.queue.release(body.connectionId);
      throw new AppError('Koneksi player sudah berakhir.',409);
    }
    const previousSocket = previous && previous !== body.connectionId ? clients.get(previous)?.socket : undefined;
    if (previousSocket?.readyState === WebSocket.OPEN) previousSocket.send(JSON.stringify({type:'player_released'}));
    res.json({ok:true, started:!before && !!rt.queue.current()});
  });
  app.post('/api/player/release', auth, async (req, res) => {
    const rt = roomFor(req,controllers), id = z.string().uuid().parse(req.body.connectionId);
    if (!ownsConnection(req,rt,id)) throw new AppError('Koneksi tidak cocok dengan ruang ini.',403);
    if (rt.queue.lease?.connectionId === id) await rt.queue.pause();
    rt.queue.release(id);
    res.json({ok:true});
  });
  const playerActions = {play:'resume',pause:'pause',next:'next',stop:'stop'} as const;
  for (const [action, method] of Object.entries(playerActions)) app.post('/api/player/' + action, auth, async (req, res) => {
    await roomFor(req,controllers).queue[method]();
    res.json({ok:true});
  });
  const changeVolume = (rt: Runtime, value: number) => {
    const {queue} = rt;
    if (!queue.lease) throw new AppError('Aktifkan player terlebih dahulu.',409);
    const owner = clients.get(queue.lease.connectionId);
    if (!owner || owner.roomId !== rt.id || owner.socket.readyState !== WebSocket.OPEN) throw new AppError('Player terputus.',409);
    owner.socket.send(JSON.stringify({type:'volume', volume:value}));
    queue.playback.volume = value;
    queue.playback.volumeUpdatedAt = Date.now();
    queue.changed();
  };
  app.post('/api/player/volume', auth, (req, res) => {
    changeVolume(roomFor(req,controllers), z.number().int().min(0).max(100).parse(req.body.volume));
    res.json({ok:true});
  });
  async function authorizeWhatsAppControl(roomId: string, groupId: string, senderId: string) {
    requireControlGroup(roomId,groupId);
    const id = normalizeParticipantId(senderId);
    const denied = () => new AppError('Kamu belum diizinkan mengontrol pemutaran di ruang ini.',403);
    if (!id || !identity.controlAliases(roomId,groupId,config.wahaSession).length) throw denied();
    const roster = await getGroupParticipants(groupId);
    const canControl = (alternate: string | null) => {
      requireControlGroup(roomId,groupId);
      const allowed = new Set(identity.controlAliases(roomId,groupId,config.wahaSession));
      const senderIds = alternate ? [id,alternate] : [id];
      if (alternate && !matchesControlIdentity(roster,id,alternate)) return false;
      return roster.some(({aliases})=>aliases.some(alias=>senderIds.includes(alias)) &&
        [...aliases,...senderIds].some(alias=>allowed.has(alias)));
    };
    if (canControl(null)) return;
    const alternate = roster.length ? await getParticipantAlias(id) : null;
    if (!alternate || !canControl(alternate)) throw denied();
  }
  const whatsappPayload = z.object({
    groupId:z.string().max(100),session:z.string().max(100).default(config.wahaSession),
    senderId:z.string().regex(/^[0-9]+@(?:c\.us|s\.whatsapp\.net|lid)$/),messageId:z.string().min(1).max(250),
    text:z.string().trim().min(1).max(1000),requester:z.string().trim().max(60).default('Anggota WhatsApp')
  });
  const verifyWhatsapp: express.RequestHandler = (req,res,next) => {
    if (!config.integrationToken || !equal(req.get('authorization') || '', 'Bearer ' + config.integrationToken)) throw new AppError('Integration token tidak valid.', 401);
    const body = whatsappPayload.parse(req.body);
    if (!/^[0-9]+@g\.us$/.test(body.groupId) || blockedGroups.has(body.groupId) || body.session !== config.wahaSession) {
      throw new AppError('Grup atau session tidak diizinkan.',403);
    }
    const pairing = body.text.match(/^\/hubungkan(?:\s+([\s\S]*))?$/i);
    const roomId = identity.roomForGroup(body.groupId,body.session);
    if (!pairing && !roomId) throw new AppError('Grup belum terhubung ke ruang.',403);
    res.locals.whatsapp = {body,pairing,roomId};
    next();
  };
  app.post('/api/integrations/whatsapp', verifyWhatsapp, rateLimit({windowMs:60000,limit:40,legacyHeaders:false}), async (_req,res) => {
    const {body,pairing,roomId} = res.locals.whatsapp as {
      body:z.output<typeof whatsappPayload>; pairing:RegExpMatchArray|null; roomId:string|null
    };
    const receiptId = body.groupId + ':' + body.messageId;
    if (pairing) {
      if (!await verifyPairingMessage(body)) throw new AppError('Asal pesan WhatsApp tidak terverifikasi.',403);
      const prior = identity.beginCommand(receiptId);
      if (prior) { res.json({reply:prior,duplicate:true}); return; }
      let reply: string;
      let commandFailed = false;
      try {
        const result = identity.consumeVerification(body.groupId,body.session,(pairing[1] || '').trim().toLowerCase(),
          id=>{
            if (joiningRooms.has(id) || joiningGroups.has(body.groupId)) {
              throw new AppError('Tunggu sampai proses bergabung selesai, lalu kirim ulang /hubungkan.',409);
            }
            return !retiringRooms.has(id);
          });
        const rt = runtime(result.roomId);
        const roomUrl = config.origin + '/?room=' + result.roomId;
        const spotifyStatus = rt.spotify.connected
          ? 'Spotify sudah terhubung. Kirim /play judul lagu untuk membuat request. Aktifkan player di dashboard untuk memutar.'
          : 'Spotify belum terhubung. Pemilik atau operator perlu menghubungkan Spotify Premium di dashboard sebelum request dapat diproses.';
        reply = 'Grup ini berhasil terhubung ke ruang *' + rt.name + '*.\n\n' + spotifyStatus + '\n\n' + roomUrl;
        broadcast(rt);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        reply = error.message;
        commandFailed = true;
      }
      identity.saveReply(receiptId,reply);
      res.json({reply,commandFailed});
      return;
    }
    const legacyReceipt = store.db.prepare('SELECT reply FROM receipts WHERE id=?').get(receiptId) as {reply:string}|undefined;
    if (legacyReceipt) { res.json({reply:legacyReceipt.reply,duplicate:true}); return; }
    if (!roomId) throw new AppError('Grup belum terhubung ke ruang.',403);
    if (verifyBoundMessages && !await verifyPairingMessage(body)) {
      throw new AppError('Asal pesan WhatsApp tidak terverifikasi.',403);
    }
    const rt = runtime(roomId);
    const previousIntegration = rt.integrationSerial;
    let finishIntegration!: () => void;
    rt.integrationSerial = new Promise<void>(resolve => { finishIntegration = resolve; });
    try {
      await previousIntegration;
      requireActiveRoom(roomId);
      if (identity.roomForGroup(body.groupId,body.session) !== roomId) throw new AppError('Grup berpindah ruang. Kirim ulang command.',403);
      const receipt = identity.beginCommand(receiptId);
      if (receipt) { res.json({reply:receipt,duplicate:true}); return; }
      try {
        const reply = await whatsappCommand(body.text, {requester:body.requester || 'Anggota WhatsApp',source:'whatsapp',senderId:body.senderId,groupId:body.groupId,messageId:body.messageId},
          {queue:rt.queue,spotify:rt.spotify,store:rt.store,roomName:rt.name,roomUrl:config.origin+'/?room='+rt.id,volume:value=>changeVolume(rt,value),
            authorizeControl:()=>authorizeWhatsAppControl(roomId,body.groupId,body.senderId)});
        identity.saveReply(receiptId,reply);
        res.json({reply});
      } catch (error) {
        const reply = error instanceof AppError ? error.message : 'Command belum selesai. Periksa /queue sebelum mencoba lagi.';
        identity.saveReply(receiptId,reply);
        if (!(error instanceof AppError)) throw error;
        res.json({reply,commandFailed:true});
      }
    } finally { finishIntegration(); }
  });
  const web = resolve('dist'); if (existsSync(web)) { app.use(express.static(web, { maxAge: '1h', index: false })); app.get('/{*path}', (req, res, next) => { if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return next(); res.set('Cache-Control', 'no-cache').sendFile(join(web, 'index.html')); }); }
  app.use((_req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan.' }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { const status = error instanceof AppError ? error.status : error instanceof z.ZodError ? 400 : 500; res.status(status).json({ error: error instanceof z.ZodError ? 'Data input tidak valid.' : status === 500 ? 'Terjadi kesalahan server. Coba lagi.' : (error as Error).message }); if (status === 500) console.error('Server error:', (error as Error).name); });
  const validClient = (token: string, roomId: string) => {
    if (retiringRooms.has(roomId)) return null;
    const user = identity.session(token);
    return user ? identity.role(user,roomId) : null;
  };
  const connectRoom = (socket: WebSocket, token: string, rt: Runtime) => {
    const id = randomUUID();
    clients.set(id,{socket,token,roomId:rt.id});
    void rt.observer.refresh();
    socket.send(JSON.stringify({type:'hello',connectionId:id}));
    socket.send(JSON.stringify({type:'snapshot',data:snapshot(rt)}));
    socket.on('error', () => socket.terminate());
    socket.on('close', () => { clients.delete(id); rt.queue.release(id); });
    socket.on('message', data => {
      try {
        if (retiringRooms.has(rt.id)) return;
        const role = validClient(token,rt.id);
        if (!role) { socket.close(1008,'Akses ruang berakhir'); return; }
        if (!controllers.includes(role) || rt.queue.lease?.connectionId !== id) return;
        const msg = JSON.parse(data.toString());
        if (msg.type === 'telemetry') {
          const state = z.object({uri:z.string().max(200),paused:z.boolean(),positionMs:z.number().min(0).max(86400000),durationMs:z.number().min(0).max(86400000)}).parse(msg.data);
          void rt.queue.telemetry(id,state).catch(error => rt.queue.error(id,error.message));
        } else if (msg.type === 'player_error') {
          rt.queue.error(id,String(msg.message || 'Player error'),msg.needsGesture === true);
        } else if (msg.type === 'volume_result' && msg.ok === false) {
          rt.queue.error(id,'Browser menolak kontrol volume. Gunakan tombol volume perangkat Android.');
        }
      } catch { socket.close(1008,'Invalid message'); }
    });
  };
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    const token = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('carubra_session='))?.slice('carubra_session='.length) || '';
    if (!req.url?.startsWith('/ws')) { socket.destroy(); return; }
    const url = new URL(req.url,config.origin);
    const roomId = url.searchParams.get('roomId') || 'default';
    if (url.pathname !== '/ws' || !validClient(token,roomId) || (origin !== config.origin && !(process.env.NODE_ENV !== 'production' && origin === 'http://127.0.0.1:5173'))) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    const rt = runtime(roomId);
    wss.handleUpgrade(req,socket,head,ws => connectRoom(ws,token,rt));
  });
  if (!provided) for (const id of identity.listActiveRoomIds()) runtime(id);
  const timer = setInterval(() => {
    const watched = new Set<string>();
    for (const [id,client] of clients) {
      if (retiringRooms.has(client.roomId)) continue;
      const role = validClient(client.token,client.roomId);
      if (!role) { runtimes.get(client.roomId)?.queue.release(id); client.socket.close(1008,'Akses ruang berakhir'); }
      else {
        watched.add(client.roomId);
        if (!controllers.includes(role)) runtime(client.roomId).queue.release(id);
        if (client.socket.readyState === WebSocket.OPEN) client.socket.ping();
      }
    }
    for (const rt of runtimes.values()) {
      if (retiringRooms.has(rt.id)) continue;
      rt.queue.tick();
      if (watched.has(rt.id) || rt.queue.current()) void rt.observer.refresh();
      if (!rt.notificationTask) {
        rt.notificationTask = rt.notifications.dispatch().then(() => broadcast(rt)).catch(() => {})
          .finally(() => { rt.notificationTask = undefined; });
      }
    }
  },5000);
  timer.unref();
  return { app, server, store, spotify, queue, notifications, observer, runtime, close: () => {
    clearInterval(timer);
    for (const client of clients.values()) client.socket.terminate();
    clients.clear();
    wss.close();
    server.close();
    for (const rt of runtimes.values()) {
      rt.observer.stop();
      rt.spotify.retire();
      rt.queue.removeAllListeners();
      rt.store.close();
    }
    if (!runtimes.has('default')) store.close();
    identity.close();
  } };
}
