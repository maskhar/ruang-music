import {test,expect} from '@playwright/test';

test('owner loads member roster on demand and saves selected controller ids only for selected group',async({page})=>{
 const groups=['120363500000000101@g.us','120363500000000123@g.us'];
 const room={id:'default',name:'Ruang utama',role:'owner',groupId:groups[0],ownerName:'Pemilik',spotifyConnected:false,playerConnected:false,isPlaying:false,currentTrack:null,queuedCount:0};
 const snapshot={roomId:'default',current:null,queue:[],history:[],playback:{connected:false,paused:true,positionMs:0,durationMs:0,updatedAt:Date.now(),volume:70,error:'',needsGesture:false},spotifyPlayback:{current:null,queue:[],observedAt:Date.now(),paused:true,positionMs:0,durationMs:0,deviceId:'',deviceName:'',volume:70,syncError:'',filteredCount:0},notificationsFailed:0,spotifyConnected:false,spotifyConfigured:false,whatsappConfigured:false};
 let rosterCalls=0;const saved:Array<{groupId:string;participantIds:string[]}>=[];const seen:string[]=[];
 await page.route('**/api/session',r=>r.fulfill({json:{authenticated:true,user:{id:'owner',name:'Pemilik',admin:true},rooms:[room]}}));
 await page.route('**/api/rooms',r=>r.fulfill({json:{rooms:[room]}}));
 await page.route('**/api/state',r=>r.fulfill({json:snapshot}));
 await page.route('**/api/rooms/default/whatsapp/control-groups',r=>r.fulfill({json:{groups}}));
 await page.route('**/api/rooms/default/whatsapp/controls**',async route=>{
  const url=new URL(route.request().url()),group=url.searchParams.get('groupId')||'';
  seen.push(route.request().method()+':'+group);
  if(route.request().method()==='GET'){
   rosterCalls++;
   return route.fulfill({json:{groupId:group,unmatchedPermissions:group===groups[1],participants:[{id:'62812345@c.us',phone:'+62812345',allowed:false},{id:'98765@lid',phone:'+62899999',allowed:false}]}});
  }
  const body=route.request().postDataJSON();saved.push(body);return route.fulfill({json:{ok:true}});
 });
 await page.routeWebSocket('**/ws**',socket=>{socket.send(JSON.stringify({type:'hello',connectionId:'test'}));socket.send(JSON.stringify({type:'snapshot',data:snapshot}));});
 await page.goto('/?room=default');
 await page.getByRole('button',{name:'Atur koneksi'}).click();
 const dialog=page.getByRole('dialog');
 await expect(dialog.getByRole('heading',{name:'Akses kontrol WhatsApp'})).toBeVisible();
 await expect(dialog.getByRole('code')).toHaveText(groups[0]);
 expect(rosterCalls,'Daftar anggota tidak dimuat sebelum diminta').toBe(0);
 await dialog.getByRole('button',{name:'Muat anggota grup'}).click();
 await expect(page.getByText('+62812345')).toBeVisible();
 expect(rosterCalls).toBe(1);
 await dialog.getByRole('checkbox').first().check();
 await dialog.getByRole('button',{name:/Simpan akses kontrol/}).click();
 await expect.poll(()=>saved.length).toBe(1);
 expect(saved[0]).toEqual({groupId:groups[0],participantIds:['62812345@c.us']});
 await expect(dialog.getByRole('status')).toContainText('disimpan');
 await dialog.locator('#controls-group').selectOption(groups[1]);
 expect(rosterCalls,'Ganti group hanya mereset list; fetch saat operator meminta').toBe(1);
 await expect(dialog.getByRole('button',{name:'Muat anggota grup'})).toBeVisible();
 await dialog.getByRole('button',{name:'Muat anggota grup'}).click();
 await expect.poll(()=>rosterCalls).toBe(2);
 expect(seen.at(-1)).toBe('GET:'+groups[1]);
 await expect(dialog.getByText(/izin lama tidak cocok/)).toBeVisible();
 await expect(dialog.getByRole('button',{name:/Simpan akses kontrol/})).toBeEnabled();
 await dialog.getByRole('button',{name:/Simpan akses kontrol/}).click();
 await expect.poll(()=>saved.length).toBe(2);
 expect(saved[1]).toEqual({groupId:groups[1],participantIds:[]});
 await expect(dialog.getByRole('status')).toContainText('Whitelist kosong');
});
