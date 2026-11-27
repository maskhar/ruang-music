import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Identity } from '../server/identity.ts';
import { AppError } from '../server/types.ts';
import { createApp } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
import { Store } from '../server/database.ts';
import WebSocket from 'ws';
import { decrypt, encrypt } from '../server/crypto.ts';

test('identitas, keanggotaan, grup, dan akun Spotify terisolasi per ruang', () => {
  const folder = mkdtempSync(join(tmpdir(), 'ruang-multi-'));
  const file = join(folder, 'identity.sqlite');
  const groupA = '120363430180897172@g.us';
  const groupB = '120363412435389448@g.us';
  const identity = new Identity(file, 'admin-password-long-enough', [groupA]);
  try {
    const admin = identity.login('owner@local', 'admin-password-long-enough');
    assert.equal(identity.session(admin.token)?.id, admin.user.id);
    assert.equal(identity.rooms(admin.user)[0].id, 'default');
    assert.equal(identity.roomForGroup(groupA, 'carubra'), 'default');
    assert.equal(identity.roomForGroup(groupA, 'different-session'), null);
    const first = identity.createRoom(admin.user, 'Ruang pertama');
    const second = identity.createRoom(admin.user, 'Ruang kedua');
    const invite = identity.invite(admin.user,first,'guest@example.test','Guest','member');
    assert.ok(invite);
    assert.equal(identity.accept(invite,'guest-password-long-enough'),'guest@example.test');
    const guestLogin = identity.login('guest@example.test', 'guest-password-long-enough');
    assert.deepEqual(identity.rooms(guestLogin.user).map(room=>room.id), [first]);
    assert.throws(() => identity.require(guestLogin.user, second), (e: unknown) => e instanceof AppError && e.status === 403);
    assert.throws(() => identity.accept(invite,'another-password-long-enough'), (e: unknown) => e instanceof AppError && e.status === 410);
    assert.equal(identity.role(guestLogin.user, first), 'member');
    assert.equal(identity.role(guestLogin.user, second), null);
    assert.throws(() => identity.require(guestLogin.user, first, ['owner', 'operator']), (e: unknown) => e instanceof AppError && e.status === 403);
    assert.throws(() => identity.beginPairing(guestLogin.user, first, groupB, 'carubra'), (e: unknown) => e instanceof AppError && e.status === 403);
    const pairing = identity.beginPairing(admin.user, first, groupB, 'carubra');
    assert.throws(() => identity.finishPairing(groupB,'carubra','invalid'), (e: unknown) => e instanceof AppError && e.status === 409);
    assert.equal(identity.finishPairing(groupB,'carubra',pairing),first);
    assert.equal(identity.roomForGroup(groupB, 'carubra'), first);
    assert.equal(identity.roomForGroup(groupB, 'other-session'), null);
    assert.throws(() => identity.finishPairing(groupB,'carubra',pairing));
    assert.throws(() => identity.beginPairing(guestLogin.user, second, groupB, 'carubra'));
    identity.bindSpotify(first, 'spotify-user-a');
    assert.throws(() => identity.bindSpotify(second, 'spotify-user-a'), (e: unknown) => e instanceof AppError && e.status === 409);
    identity.bindSpotify(second, 'spotify-user-b');
    identity.db.prepare('DELETE FROM room_members WHERE room_id=? AND user_id=?').run(first,guestLogin.user.id);
    assert.equal(identity.session(guestLogin.token)?.id,guestLogin.user.id);
    assert.equal(identity.role(guestLogin.user,first),null);
    assert.deepEqual(identity.rooms(guestLogin.user),[]);
    identity.logout(guestLogin.token);
    assert.equal(identity.session(guestLogin.token), null);
  } finally { identity.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('OAuth Spotify menolak akun sama lintas ruang tanpa mengganti token lama', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'ruang-oauth-'));
  const config = loadConfig({ ADMIN_PASSWORD: 'admin-password-long-enough', ENCRYPTION_KEY: 'a'.repeat(64), APP_ORIGIN: 'http://127.0.0.1:3210', DATA_DIR: folder, SPOTIFY_CLIENT_ID: 'test-client-id' });
  const app = createApp(config, new Store(':memory:'));
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
  const login = async () => {
    const response = await fetch(base+'/api/login', {method:'POST',headers:{Origin:config.origin,'Content-Type':'application/json'},body:JSON.stringify({password:config.password})});
    assert.equal(response.status,200);
    return response.headers.get('set-cookie')!.split(';')[0];
  };
  const begin = async (roomId:string,cookie:string) => {
    const response = await fetch(base+'/auth/spotify?room='+roomId,{headers:{Cookie:cookie},redirect:'manual'});
    assert.equal(response.status,302);
    return new URL(response.headers.get('location')!).searchParams.get('state')!;
  };
  const callback = (state:string,cookie:string) => fetch(base+'/auth/spotify/callback?state='+encodeURIComponent(state)+'&code=mock-code',{headers:{Cookie:cookie},redirect:'manual'});
  const oauthResult = (id:string, token:string) => ({ profile:{id,product:'premium',display_name:id}, encryptedTokens:encrypt({access_token:token,refresh_token:'refresh-'+token,expiresAt:Date.now()+3600000,scope:'streaming'},config.encryptionKey) });
  try {
    const cookie=await login(), otherSession=await login();
    const created=await fetch(base+'/api/rooms',{method:'POST',headers:{Cookie:cookie,Origin:config.origin,'Content-Type':'application/json'},body:JSON.stringify({name:'Ruang kedua'})});
    assert.equal(created.status,201);
    const roomB=(await created.json() as {id:string}).id;
    const stateA=await begin('default',cookie);
    app.spotify.exchange=async()=>oauthResult('spotify-a','token-a');
    assert.equal((await callback(stateA,otherSession)).status,400);
    assert.equal(app.store.get('spotifyTokens'),null);
    assert.equal((await callback(stateA,cookie)).status,302);
    const tokenA=app.store.get<string>('spotifyTokens');
    assert.ok(tokenA);
    assert.equal(decrypt<{access_token:string}>(tokenA,config.encryptionKey).access_token,'token-a');
    const rtB=app.runtime(roomB);
    assert.equal((await callback(stateA.replace('default.',roomB+'.'),cookie)).status,400);
    rtB.spotify.exchange=async()=>oauthResult('spotify-b','token-b');
    assert.equal((await callback(await begin(roomB,cookie),cookie)).status,302);
    const previous=rtB.store.get<string>('spotifyTokens');
    assert.ok(previous);
    rtB.spotify.exchange=async()=>oauthResult('spotify-a','attempted-replacement');
    assert.equal((await callback(await begin(roomB,cookie),cookie)).status,409);
    assert.equal(rtB.store.get<string>('spotifyTokens'),previous);
    assert.equal(decrypt<{access_token:string}>(previous,config.encryptionKey).access_token,'token-b');
    assert.equal((await callback('default.invalid-state',cookie)).status,400);
  } finally { app.close(); rmSync(folder,{recursive:true,force:true}); }
});

test('API memisahkan antrean, anggota, dan command WhatsApp dua ruang', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'ruang-http-'));
  const groups = ['120363430180897172@g.us', '120363412435389448@g.us'];
  const config = loadConfig({ ADMIN_PASSWORD: 'admin-password-long-enough', ENCRYPTION_KEY: 'a'.repeat(64), APP_ORIGIN: 'http://127.0.0.1:3210', DATA_DIR: folder, INTEGRATION_TOKEN: 'integration-test-token', WHATSAPP_GROUP_IDS: groups.join(','), WAHA_SESSION: 'carubra' });
  const app = createApp(config, new Store(':memory:'));
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
  const track = { uri: 'spotify:track:6sGIMrtIzQjdzNndVxe397', title: 'Lagu uji', artist: 'Artis uji', album: '', image: '', durationMs: 180000, url: 'https://open.spotify.com/track/6sGIMrtIzQjdzNndVxe397' };
  const request = async (path: string, method = 'GET', body?: unknown, cookie = '', roomId = 'default') => {
    const response = await fetch(base + path, { method, headers: { Origin: config.origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-Room-Id': roomId }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { response, data: await response.json() as any };
  };
  const command = async (groupId: string, text: string, messageId: string, session = 'carubra') => {
    const response = await fetch(base + '/api/integrations/whatsapp', { method: 'POST', headers: { Authorization: 'Bearer integration-test-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ session, groupId, senderId: '628123@c.us', messageId, text }) });
    return { response, data: await response.json() as any };
  };
  try {
    const login = await request('/api/login', 'POST', { password: config.password });
    assert.equal(login.response.status, 200);
    const adminCookie = login.response.headers.get('set-cookie')!.split(';')[0];
    const created = await request('/api/rooms', 'POST', { name: 'Ruang kedua' }, adminCookie);
    assert.equal(created.response.status, 201);
    const roomB = created.data.id as string;
    assert.ok(roomB);
    app.spotify.resolve = async () => [track];
    app.runtime(roomB).spotify.resolve = async () => [{ ...track, title: 'Lagu ruang B' }];
    app.spotify.token = async () => 'token-room-default';
    app.runtime(roomB).spotify.token = async () => 'token-room-b';
    assert.equal((await request('/api/spotify/token','GET',undefined,adminCookie)).data.accessToken,'token-room-default');
    assert.equal((await request('/api/spotify/token','GET',undefined,adminCookie,roomB)).data.accessToken,'token-room-b');
    const first = await request('/api/requests', 'POST', { input: 'test', requester: 'Operator' }, adminCookie);
    const second = await request('/api/requests', 'POST', { input: 'test', requester: 'Operator' }, adminCookie, roomB);
    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 201);
    assert.deepEqual((await request('/api/state', 'GET', undefined, adminCookie)).data.queue.map((r: any) => r.title), ['Lagu uji']);
    assert.deepEqual((await request('/api/state', 'GET', undefined, adminCookie, roomB)).data.queue.map((r: any) => r.title), ['Lagu ruang B']);

    const member = await request(`/api/rooms/${roomB}/members`, 'POST', { email: 'member@example.test', name: 'Anggota', role: 'member' }, adminCookie);
    assert.equal(member.response.status, 201);
    const inviteUrl = member.data.inviteUrl as string;
    assert.ok(inviteUrl);
    const inviteToken = new URL(inviteUrl).searchParams.get('invite');
    assert.ok(inviteToken);
    const accepted = await request('/api/invitations/accept', 'POST', { token: inviteToken, password: 'member-password-long-enough' });
    assert.equal(accepted.response.status, 200);
    const memberLogin = await request('/api/login', 'POST', { email: 'member@example.test', password: 'member-password-long-enough' });
    assert.equal(memberLogin.response.status, 200);
    const memberCookie = memberLogin.response.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await request('/api/state', 'GET', undefined, memberCookie, roomB)).response.status, 200);
    assert.equal((await request('/api/state', 'GET', undefined, memberCookie, 'default')).response.status, 403);
    assert.equal((await request('/api/spotify/token', 'GET', undefined, memberCookie, roomB)).response.status, 403);
    assert.equal((await request('/api/queue/clear', 'POST', {}, memberCookie, roomB)).response.status, 403);
    const wsDenied = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(base.replace('http://','ws://') + '/ws?roomId=default', { headers: { Origin: config.origin, Cookie: memberCookie } });
      socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode || 0); });
      socket.once('open', () => { socket.close(); reject(new Error('Anggota dapat membuka WebSocket ruang lain.')); });
      socket.once('error', reject);
    });
    assert.equal(wsDenied, 401);

    assert.equal((await command('120363999999999999@g.us','/queue','blocked-group')).response.status,403);
    assert.equal((await command(groups[0],'/queue','blocked-session','other-session')).response.status,403);
    const beforeMove = await command(groups[1],'/queue','same-message');
    assert.equal(beforeMove.response.status,200);
    assert.match(beforeMove.data.reply,/Lagu uji/);

    const pairing = await request(`/api/rooms/${roomB}/groups`, 'POST', { groupId: groups[1], session: 'carubra' }, adminCookie);
    assert.equal(pairing.response.status, 201);
    assert.ok(pairing.data.code);
    const paired = await command(groups[1], `/hubungkan ${pairing.data.code}`, 'pair-1');
    assert.equal(paired.response.status, 200);
    assert.match(paired.data.reply, /ruang|terhubung/i);
    const afterMove = await command(groups[1],'/queue','same-message');
    assert.equal(afterMove.response.status,200);
    // Reusing the same WAHA message ID after moving groups cannot repeat
    // a prior side effect; receipt identity stays group-scoped.
    assert.equal(afterMove.data.duplicate,true);
    assert.match(afterMove.data.reply,/Lagu uji/);
    const runtimeB=app.runtime(roomB);
    runtimeB.spotify.api=async()=>null;
    await runtimeB.queue.claim('isolated-player','mock-device');
    const played = await command(groups[1], '/play lagu uji', 'play-1');
    assert.equal(played.response.status, 200);
    assert.equal(app.runtime(roomB).store.list('queued').length, 1);
    assert.equal(app.store.list('queued').length, 1);
    await runtimeB.queue.next();
    const active=runtimeB.queue.current();
    assert.ok(active);
    assert.equal(active.groupId,groups[1]);
    await runtimeB.queue.telemetry('isolated-player',{uri:active.uri,paused:false,positionMs:1000,durationMs:active.durationMs});
    const outbox=runtimeB.store.db.prepare('SELECT data FROM outbox ORDER BY created_at DESC LIMIT 1').get() as {data:string}|undefined;
    assert.ok(outbox);
    assert.equal(JSON.parse(outbox.data).groupId,groups[1]);
    assert.equal(app.store.db.prepare('SELECT count(*) n FROM outbox').get()?.n,0);
    assert.equal((await command(groups[1], `/hubungkan ${pairing.data.code}`, 'pair-2')).data.commandFailed, true);
  } finally { app.close(); rmSync(folder, { recursive: true, force: true }); }
});
