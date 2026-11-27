import test from 'node:test';
import assert from 'node:assert/strict';
import { Spotify } from '../server/spotify.ts';
import { Queue } from '../server/queue.ts';
import { Store } from '../server/database.ts';
import { loadConfig } from '../server/config.ts';
import { AppError } from '../server/types.ts';

test('/next menerima HTTP 200 kosong dari pause dan play tanpa kehilangan antrean', async () => {
  const store = new Store(':memory:');
  const spotify = new Spotify(loadConfig({ADMIN_PASSWORD:'test-password-123456',ENCRYPTION_KEY:'a'.repeat(64)}), store);
  spotify.token = async () => 'mock-token';
  const original = globalThis.fetch;
  const calls: {path:string; body:unknown}[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({path:String(input),body:init?.body ? JSON.parse(String(init.body)) : null});
    return new Response('', {status:200});
  };
  try {
    const queue = new Queue(store, spotify);
    await queue.claim('owner','device');
    const tracks = ['a','b','c'].map(title => ({uri:'spotify:track:'+title,title,artist:'Test',album:'',image:'',durationMs:100000,url:''}));
    await queue.enqueue(tracks,{requester:'Test',source:'web'});
    await queue.telemetry('owner',{uri:tracks[0].uri,paused:false,positionMs:1000,durationMs:100000});
    await queue.next();
    assert.equal(queue.current()?.title,'b');
    assert.equal(store.list('skipped')[0]?.title,'a');
    assert.deepEqual(store.list('queued').map(row=>row.title),['c']);
    assert.match(calls.at(-2)!.path,/\/pause\?/);
    assert.deepEqual(calls.at(-1)!.body,{uris:[tracks[1].uri]});
    assert.equal(queue.current()?.status,'starting');
    globalThis.fetch = async () => new Response('{broken', {status:200});
    await assert.rejects(()=>spotify.api('/me/player'), error=>error instanceof AppError && error.status===502);
    globalThis.fetch = async () => Response.json({is_playing:true});
    assert.deepEqual(await spotify.api('/me/player'),{is_playing:true});
  } finally { globalThis.fetch=original; store.close(); }
});
