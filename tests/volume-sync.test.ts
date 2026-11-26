import test from 'node:test';
import assert from 'node:assert/strict';
import { playbackView } from '../src/playback-view.ts';
import { Store } from '../server/database.ts';
import { Queue } from '../server/queue.ts';
import type { Snapshot, SpotifyPlayback } from '../server/types.ts';
const native:SpotifyPlayback={current:null,queue:[],observedAt:Date.now(),paused:false,positionMs:0,durationMs:0,deviceId:'player',deviceName:'Player',volume:10,syncError:'',filteredCount:0};
test('volume Spotify dipakai juga untuk request aplikasi aktif, termasuk mute',()=>{const snapshot={current:{id:'request',uri:'spotify:track:test'},queue:[],playback:{connected:true,volume:100},spotifyPlayback:native} as unknown as Snapshot;assert.equal(playbackView(snapshot).volume,10);assert.equal(playbackView({...snapshot,playback:{...snapshot.playback,volume:40,volumeUpdatedAt:native.observedAt+1000}}).volume,40);assert.equal(playbackView({...snapshot,spotifyPlayback:{...native,volume:0}}).volume,0);assert.equal(playbackView({...snapshot,spotifyPlayback:{...native,syncError:'offline'}}).volume,100);assert.equal(playbackView({...snapshot,spotifyPlayback:{...native,deviceId:''}}).volume,100);});
test('backend memperbarui volume hanya dari perangkat player yang dimiliki',async()=>{const store=new Store(':memory:');const queue=new Queue(store,{connected:true,api:async()=>null});await queue.claim('owner','player');await queue.reconcile(native);assert.equal(queue.playback.volume,10);await queue.reconcile({...native,deviceId:'other',volume:90});assert.equal(queue.playback.volume,10);await queue.reconcile({...native,syncError:'offline',volume:90});assert.equal(queue.playback.volume,10);store.close();});
