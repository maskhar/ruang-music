import {test,expect,type Page,type Route} from '@playwright/test';

const groupLink='https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv?mode=invite';
async function openSettings(page:Page, joinHandler:(route:Route)=>Promise<void>){
 const rooms=[{id:'default',name:'Ruang utama',role:'owner',groupId:null,ownerName:'Pemilik',spotifyConnected:false,playerConnected:false,isPlaying:false,currentTrack:null,queuedCount:0}];
 const snapshot={roomId:'default',current:null,queue:[],history:[],playback:{connected:false,paused:true,positionMs:0,durationMs:0,updatedAt:Date.now(),volume:70,error:'',needsGesture:false},spotifyPlayback:{current:null,queue:[],observedAt:Date.now(),paused:true,positionMs:0,durationMs:0,deviceId:'',deviceName:'',volume:70,syncError:'',filteredCount:0},notificationsFailed:0,spotifyConnected:false,spotifyConfigured:false,whatsappConfigured:true,callbackUrl:'http://127.0.0.1:3231/auth/spotify/callback'};
 await page.route('**/api/session',r=>r.fulfill({json:{authenticated:true,user:{id:'owner',name:'Pemilik',email:'owner@local',admin:true},rooms}}));
 await page.route('**/api/rooms',r=>r.fulfill({json:{rooms}}));
 await page.route('**/api/rooms/default/pairing',r=>r.fulfill({json:{code:'0123456789abcdef0123',expiresAt:Date.now()+600000}}));
 await page.route('**/api/state',r=>r.fulfill({json:snapshot}));
 await page.route('**/api/rooms/default/whatsapp/join',joinHandler);
 await page.routeWebSocket('**/ws**',ws=>{ws.send(JSON.stringify({type:'hello',connectionId:'browser-test'}));ws.send(JSON.stringify({type:'snapshot',data:snapshot}));});
 await page.goto('/?room=default');
 await page.getByRole('button',{name:'Atur koneksi'}).click();
 await expect(page.getByRole('dialog')).toBeVisible();
 await expect(page.getByLabel('Tautan undangan grup WhatsApp')).toBeVisible();
}

test('join grup mock menunjukkan status pending, membersihkan link dan tetap minta /hubungkan',async({page})=>{
 let calls=0;
 await openSettings(page,async route=>{
  calls++;
  expect(route.request().postDataJSON()).toEqual({inviteUrl:groupLink});
  await route.fulfill({json:{status:'pending',groupName:'Grup internal'}});
 });
 await page.getByLabel('Tautan undangan grup WhatsApp').fill(groupLink);
 await page.getByRole('button',{name:'Gabungkan Carubra'}).click();
 await expect(page.getByRole('status').filter({hasText:'belum mengonfirmasi'})).toContainText('Grup internal');
 await expect(page.getByRole('status').filter({hasText:'belum mengonfirmasi'})).toContainText('/hubungkan');
 await expect(page.getByLabel('Tautan undangan grup WhatsApp')).toHaveValue('');
 expect(calls).toBe(1);
 await expect(page.getByText('Kode khusus ruang ini berlaku 10 menit.')).toBeVisible();
});

test('join grup mock sukses tanpa melewati verifikasi pairing',async({page})=>{
 let calls=0;
 await openSettings(page,async route=>{calls++;await route.fulfill({json:{status:'joined',groupName:'Grup aman'}});});
 await page.getByLabel('Tautan undangan grup WhatsApp').fill(groupLink);
 await page.getByRole('button',{name:'Gabungkan Carubra'}).click();
 await expect(page.getByRole('status').filter({hasText:'berhasil bergabung'})).toContainText('/hubungkan');
 await expect(page.getByRole('dialog').getByText('/hubungkan 0123456789abcdef0123')).toBeVisible();
 expect(calls).toBe(1);
});

test('join error tidak membocorkan invite URL ke UI',async({page})=>{
 const error='WAHA gagal untuk https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv?mode=invite';
 await openSettings(page,route=>route.fulfill({status:502,json:{error}}));
 await page.getByLabel('Tautan undangan grup WhatsApp').fill(groupLink);
 await page.getByRole('button',{name:'Gabungkan Carubra'}).click();
 await expect(page.getByRole('alert')).toContainText('[tautan disembunyikan]');
 await expect(page.getByRole('alert')).not.toContainText('AbCdEfGhIjKlMnOpQrStUv');
 await expect(page.getByLabel('Tautan undangan grup WhatsApp')).toHaveValue('');
});
