import { test, expect } from '@playwright/test';
test('operator login, dashboard responsif, settings, riwayat, logout',async({page},info)=>{const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');await expect(page.getByRole('heading',{name:'Selamat datang kembali.'})).toBeVisible();await page.getByLabel('Password operator',{exact:true}).fill('browser-test-password');await page.getByRole('button',{name:'Masuk ke Ruang Musik'}).click();await expect(page.getByRole('heading',{name:'Hari ini, dengar apa?'})).toBeVisible();await expect(page.getByText('Realtime terhubung')).toBeAttached();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:`test-results/dashboard-${info.project.name}.png`,fullPage:true});await page.getByRole('button',{name:'Atur koneksi'}).click();await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByText('http://127.0.0.1:3211/auth/spotify/callback',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Tutup',exact:true}).click();await page.getByRole('button',{name:'Riwayat',exact:true}).click();await expect(page.getByRole('heading',{name:'Belum ada riwayat.'})).toBeVisible();await page.getByRole('button',{name:'Buka pengaturan'}).click();await page.getByRole('button',{name:'Keluar dari akun operator'}).click();await expect(page.getByRole('heading',{name:'Selamat datang kembali.'})).toBeVisible();expect(errors).toEqual([]);});

test('snapshot Spotify mengisi metadata dan antrean lalu berubah realtime tanpa reload', async ({ page }, info) => {
  const track = (name: string) => ({ uri: `spotify:track:${name}`, title: name, artist: 'Artis Uji', album: 'Album', image: '', durationMs: 200000, url: `https://open.spotify.com/track/${name}` });
  const snapshot = { current: null, queue: [], history: [], playback: { connected: true, deviceName: 'Browser', paused: false, positionMs: 10000, durationMs: 200000, updatedAt: Date.now(), volume: 70, error: '', needsGesture: false }, spotifyPlayback: { current: track('Lagu Aktif'), queue: [track('Lagu Berikutnya Satu'), track('Lagu Berikutnya Dua')], observedAt: Date.now(), paused: false, positionMs: 10000, durationMs: 200000, deviceId: 'browser', deviceName: 'Player Kantor', volume: 70, syncError: '', filteredCount: 9 }, notificationsFailed: 0, spotifyConnected: true, spotifyConfigured: true, whatsappConfigured: true, callbackUrl: 'http://127.0.0.1:3211/auth/spotify/callback', origin: 'http://127.0.0.1:3211' };
  let socket: any;
  await page.route('**/api/session', route => route.fulfill({ json: { authenticated: true } }));
  await page.route('**/api/state', route => route.fulfill({ json: snapshot }));
  await page.routeWebSocket('**/ws', ws => { socket = ws; ws.send(JSON.stringify({ type: 'hello', connectionId: 'browser-test' })); ws.send(JSON.stringify({ type: 'snapshot', data: snapshot })); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Lagu Aktif', exact: true })).toBeVisible();
  await expect(page.locator('.queue-row')).toHaveCount(2);
  await expect(page.locator('.count-pill')).toHaveText('2');
  await expect(page.locator('.output-label')).toHaveText('Player Kantor');
  await expect(page.getByRole('link', { name: 'Lagu Berikutnya Satu', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Hapus request/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Kosongkan request web' })).toBeDisabled();
  await page.screenshot({ path: `test-results/spotify-sync-${info.project.name}.png`, fullPage: true });
  snapshot.spotifyPlayback.current = track('Lagu Berikutnya Satu');
  snapshot.spotifyPlayback.queue = [track('Lagu Berikutnya Dua')];
  socket.send(JSON.stringify({ type: 'snapshot', data: snapshot }));
  await expect(page.getByRole('heading', { name: 'Lagu Berikutnya Satu', exact: true })).toBeVisible();
  await expect(page.locator('.queue-row')).toHaveCount(1);
  await expect(page.locator('.count-pill')).toHaveText('1');
  snapshot.spotifyPlayback.queue = [];
  snapshot.spotifyPlayback.paused = true;
  socket.send(JSON.stringify({ type: 'snapshot', data: snapshot }));
  await expect(page.locator('.queue-row')).toHaveCount(0);
  await expect(page.locator('.count-pill')).toHaveText('0');
  await expect(page.locator('.live-status')).toContainText('Dijeda');
});

test('player idle tidak menampilkan request lama sebagai lagu aktif atau antrean berjalan',async({page},info)=>{
 const old={uri:'spotify:track:old',title:'Lagu lama terhenti',artist:'Artis',album:'Album',image:'',durationMs:200000,url:'https://open.spotify.com/track/old',id:'old',requester:'Operator',source:'web',status:'playing',createdAt:1,startedAt:2,positionMs:0,error:''};
 const snapshot={current:old,queue:[{...old,id:'waiting',title:'Request tersimpan Duka',status:'queued'}],history:[],playback:{connected:false,paused:true,positionMs:0,durationMs:200000,updatedAt:Date.now(),volume:70,error:'',needsGesture:false},spotifyPlayback:{current:null,queue:[],observedAt:Date.now(),paused:true,positionMs:0,durationMs:0,deviceId:'',deviceName:'',volume:70,syncError:'',filteredCount:0},notificationsFailed:0,spotifyConnected:true,spotifyConfigured:true,whatsappConfigured:true};
 await page.route('**/api/session',r=>r.fulfill({json:{authenticated:true}}));await page.route('**/api/state',r=>r.fulfill({json:snapshot}));await page.routeWebSocket('**/ws',ws=>{ws.send(JSON.stringify({type:'hello',connectionId:'test'}));ws.send(JSON.stringify({type:'snapshot',data:snapshot}));});await page.goto('/');
 await expect(page.getByRole('heading',{name:'Tidak ada lagu diputar.',exact:true})).toBeVisible();await expect(page.getByText('Lagu lama terhenti',{exact:true})).toHaveCount(0);await expect(page.locator('.queue-title .count-pill')).toHaveText('0');await expect(page.locator('.queue-row')).toHaveCount(0);await expect(page.getByRole('region',{name:'Request tersimpan'})).toBeVisible();await expect(page.getByRole('link',{name:'Request tersimpan Duka'})).toBeVisible();await expect(page.locator('.mini-current strong')).toHaveText('Belum ada lagu diputar');await expect(page.locator('.time-labels')).toHaveText('0:000:00');await page.screenshot({path:`test-results/idle-fixed-${info.project.name}.png`,fullPage:true});
});

test('refresh browser player memulihkan koneksi dan seluruh antrean tanpa login Spotify ulang',async({page})=>{
 const active={uri:'spotify:track:active',title:'Lagu aktif',artist:'Artis',album:'',image:'',durationMs:200000,url:'https://open.spotify.com/track/active',id:'active',requester:'Operator',source:'web',status:'playing',createdAt:1,startedAt:2,positionMs:30000,error:''};
 const snapshot={current:active,queue:[{...active,id:'next',title:'Berikutnya',status:'queued'}],history:[],playback:{connected:false,paused:true,positionMs:30000,durationMs:200000,updatedAt:Date.now(),volume:70,error:'',needsGesture:false},spotifyPlayback:{current:active,queue:[],observedAt:Date.now(),paused:false,positionMs:30000,durationMs:200000,deviceId:'previous',deviceName:'Player',volume:70,syncError:'',filteredCount:0},notificationsFailed:0,spotifyConnected:true,spotifyConfigured:true,whatsappConfigured:true};
 let claims=0,plays=0,sockets=0;
 await page.addInitScript(()=>sessionStorage.setItem('carubra-player',JSON.stringify({active:true,playing:true})));
 await page.route('**/api/session',r=>r.fulfill({json:{authenticated:true}}));await page.route('**/api/state',r=>r.fulfill({json:snapshot}));
 await page.route('**/api/player/claim',r=>{expect(r.request().postDataJSON().takeover).toBe(false);claims++;return r.fulfill({json:{ok:true}});});await page.route('**/api/player/play',r=>{plays++;return r.fulfill({json:{ok:true}});});
 await page.route('https://sdk.scdn.co/spotify-player.js',r=>r.fulfill({contentType:'text/javascript',body:`window.Spotify={Player:class{listeners={};addListener(name,fn){this.listeners[name]=fn;}activateElement(){return Promise.resolve();}connect(){queueMicrotask(()=>this.listeners.ready({device_id:'restored-device'}));return Promise.resolve(true);}getCurrentState(){return Promise.resolve({paused:false,position:30000,duration:200000,track_window:{current_track:{uri:'spotify:track:active'}}});}disconnect(){}}};window.onSpotifyWebPlaybackSDKReady();`}));
 await page.routeWebSocket('**/ws',ws=>{ws.send(JSON.stringify({type:'hello',connectionId:'connection-'+(++sockets)}));ws.send(JSON.stringify({type:'snapshot',data:snapshot}));});
 await page.goto('/');await expect.poll(()=>claims).toBe(1);await expect.poll(()=>plays).toBe(1);await page.reload();await expect.poll(()=>claims).toBe(2);await expect.poll(()=>plays).toBe(2);await expect(page.getByRole('heading',{name:'Lagu aktif',exact:true})).toBeVisible();
});
