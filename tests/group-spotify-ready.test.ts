import test from 'node:test';
import assert from 'node:assert/strict';
import { Notifications } from '../server/notifications.ts';
import { Store } from '../server/database.ts';
import { loadConfig } from '../server/config.ts';

test('notifikasi Spotify siap hanya dikirim ke grup yang masih terhubung saat pengiriman',async () => {
  const config = loadConfig({
    ADMIN_PASSWORD:'testing-password-only',
    ENCRYPTION_KEY:'a'.repeat(64),
    WAHA_URL:'https://waha.test',
    WAHA_API_KEY:'testing-key',
    WAHA_SESSION:'carubra'
  });
  const store = new Store(':memory:');
  const groupId = '900000000000000002@g.us';
  let bound = true;
  const notices = new Notifications(store,config,group => group === groupId && bound);
  const roomUrl = 'https://example.test/?room=example';
  const sent: {chatId:string;session:string;text:string}[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input,init) => {
    assert.equal(input,'https://waha.test/api/sendText');
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({id:'mock-confirmed'});
  };
  try {
    notices.enqueueSpotifyReady({groupId,roomUrl,roomName:'Kafe Uji'});
    await notices.dispatch();
    await notices.dispatch();
    assert.equal(sent.length,1);
    assert.equal(sent[0].chatId,groupId);
    assert.equal(sent[0].session,'carubra');
    assert.ok(sent[0].text.includes(roomUrl));
    assert.match(sent[0].text,/Spotify sudah terhubung/);

    notices.enqueueSpotifyReady({groupId,roomUrl,roomName:'Kafe Uji'});
    bound = false;
    await notices.dispatch();
    assert.equal(sent.length,1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status='failed'").get()?.count,1);
  } finally {
    globalThis.fetch = original;
    store.close();
  }
});
