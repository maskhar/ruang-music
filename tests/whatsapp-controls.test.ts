import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server/app.ts';
import {Store} from '../server/database.ts';
import {loadConfig} from '../server/config.ts';
import {AppError} from '../server/types.ts';
import {getWahaGroupParticipants,getWahaParticipantAlias} from '../server/waha.ts';

test('kontrol WhatsApp hanya pemilik; anggota grup yang diizinkan tetap diverifikasi dan izin tidak bocor antar ruang',async()=>{
 const groupA='120363500000000101@g.us', groupB='120363500000000123@g.us';
 const caller='62812345@c.us', lid='123456789@lid', other='62899999@c.us';
 const participant={id:lid,phone:caller,aliases:[lid,caller]};
 let members:typeof participant[]=[participant,{id:other,phone:other,aliases:[other]}];
 let providerOnline=true;
 let mappedAlias:string|null=null;
 const observedGroups:string[]=[];
 const actionCalls:string[]=[];
 const config=loadConfig({ADMIN_PASSWORD:'password-long-enough',ENCRYPTION_KEY:'a'.repeat(64),APP_ORIGIN:'http://127.0.0.1:3210',INTEGRATION_TOKEN:'mock-integration',WHATSAPP_GROUP_IDS:groupA,WAHA_SESSION:'carubra'});
 const app=createApp(config,new Store(':memory:'),{
  verifyPairingMessage:async()=>true,
  getGroupParticipants:async(groupId:string)=>{observedGroups.push(groupId);if(!providerOnline)throw new AppError('WAHA tidak tersedia.',503);return members.map(person=>({...person}));},
  getParticipantAlias:async()=>mappedAlias
 });
 await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
 const request=(path:string,method='GET',body?:unknown,cookie='')=>fetch(base+path,{method,headers:{Origin:config.origin,Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const command=(groupId:string,senderId:string,text:string,id:string)=>fetch(base+'/api/integrations/whatsapp',{method:'POST',headers:{Authorization:'Bearer '+config.integrationToken,'Content-Type':'application/json'},body:JSON.stringify({groupId,session:'carubra',senderId,messageId:id,text})});
 try{
  const login=await request('/api/login','POST',{password:config.password});assert.equal(login.status,200);
  const admin=login.headers.get('set-cookie')!.split(';')[0];
  const created=await request('/api/rooms','POST',{name:'Ruang B'},admin);assert.equal(created.status,201);
  const roomB=(await created.json() as {id:string}).id;
  const queueA=app.queue;
  const oldStop=queueA.stop.bind(queueA);
  queueA.stop=async()=>{actionCalls.push('stop');return oldStop();};
  queueA.pause=async()=>{actionCalls.push('pause');};
  const pairing=await request(`/api/rooms/${roomB}/pairing`,'GET',undefined,admin);
  const code=(await pairing.json() as {code:string}).code;
  assert.equal((await command(groupB,caller,'/hubungkan '+code,'pair-room-b')).status,200);
  const invite=async(role:'operator'|'member',email:string)=>{
   const result=await request('/api/rooms/default/members','POST',{email,name:role,role},admin);
   assert.equal(result.status,201);
   const token=new URL((await result.json() as {inviteUrl:string}).inviteUrl).searchParams.get('invite');assert.ok(token);
   assert.equal((await request('/api/invitations/accept','POST',{token,password:'guest-password-long-enough'})).status,200);
   const response=await request('/api/login','POST',{email,password:'guest-password-long-enough'});
   assert.equal(response.status,200);return response.headers.get('set-cookie')!.split(';')[0];
  };
  const operator=await invite('operator','operator@control.test');
  const member=await invite('member','member@control.test');
  const controlsA='/api/rooms/default/whatsapp/controls?groupId='+encodeURIComponent(groupA);
  const controlGroups='/api/rooms/default/whatsapp/control-groups';
  for(const cookie of [operator,member]){
   assert.equal((await request(controlGroups,'GET',undefined,cookie)).status,403);
   assert.equal((await request(controlsA,'GET',undefined,cookie)).status,403);
   assert.equal((await request(controlsA,'PUT',{groupId:groupA,participantIds:[lid]},cookie)).status,403);
  }
  assert.deepEqual(await (await request(controlGroups,'GET',undefined,admin)).json(),{groups:[groupA]});
  assert.deepEqual(await (await request('/api/rooms/'+roomB+'/whatsapp/control-groups','GET',undefined,admin)).json(),{groups:[groupB]});
  assert.equal((await request('/api/rooms/'+roomB+'/whatsapp/controls?groupId='+encodeURIComponent(groupA),'GET',undefined,admin)).status,403);
  const first=await request(controlsA,'GET',undefined,admin);assert.equal(first.status,200);
  const initial=await first.json() as {groupId:string;participants:Array<{id:string;phone:string|null;allowed:boolean}>};
  assert.equal(initial.groupId,groupA);
  assert.equal(initial.participants.find(item=>item.id===lid)?.allowed,false);
  assert.equal(initial.participants.find(item=>item.id===lid)?.phone,caller);
  assert.equal((await request(controlsA,'PUT',{groupId:groupB,participantIds:[lid]},admin)).status,403,'Grup ruang lain tidak boleh diubah');
  assert.equal((await request(controlsA,'PUT',{groupId:groupA,participantIds:['62855555@c.us']},admin)).status,409,'ID yang tidak ada dalam grup tidak dapat diizinkan');
  const protectedCommands=['/next','/skip','/stop','/pause','/vol 10','/volume 11'];
  for(const [index,text] of protectedCommands.entries()){
   const response=await command(groupA,caller,text,'unlisted-'+index);assert.equal(response.status,200);
   const data=await response.json() as {commandFailed?:boolean;reply:string};
   assert.equal(data.commandFailed,true,`Ditolak tanpa izin: ${text}`);
  }
  assert.deepEqual(actionCalls,[],'Whitelist kosong tidak boleh memanggil kontrol player');
  const track={uri:'spotify:track:test',title:'Judul',artist:'Artis',album:'',image:'',durationMs:100000,url:'https://open.spotify.com/track/test'};
  app.spotify.resolve=async()=>[track];
  assert.equal((await command(groupA,caller,'/play Judul','play-open')).status,200);
  assert.equal(app.store.list('queued').length,1,'Request lagu tetap terbuka untuk anggota');
  assert.equal((await command(groupA,caller,'/queue','read-open')).status,200);
  assert.equal((await request(controlsA,'PUT',{groupId:groupA,participantIds:[lid]},admin)).status,200);
  const allowed=await (await request(controlsA,'GET',undefined,admin)).json() as {participants:Array<{id:string;allowed:boolean}>};
  assert.equal(allowed.participants.find(person=>person.id===lid)?.allowed,true);
  const controlsB='/api/rooms/'+roomB+'/whatsapp/controls?groupId='+encodeURIComponent(groupB);
  const deniedB=await command(groupB,caller,'/stop','room-b-denied');assert.equal(deniedB.status,200);
  assert.equal((await deniedB.json() as {commandFailed:boolean}).commandFailed,true);
  assert.equal((await (await command(groupB,caller,'/stop','room-b-denied2')).json() as {commandFailed:boolean}).commandFailed,true,'Izin ruang A tidak berlaku di ruang B');
  const authorized=await command(groupA,caller,'/stop','room-a-allowed');assert.equal(authorized.status,200);
  assert.equal((await authorized.json() as {commandFailed?:boolean}).commandFailed,undefined);
  assert.equal(app.store.list('queued').length,0);
  assert.deepEqual(actionCalls,['stop']);
  assert.equal((await request(controlsB,'PUT',{groupId:groupB,participantIds:[lid]},admin)).status,200);
  members=[{id:caller,phone:caller,aliases:[caller]},{id:other,phone:other,aliases:[other]}];
  mappedAlias=caller;
  const viaLid=await command(groupA,lid,'/pause','lid-alias-allowed');
  assert.equal((await viaLid.json() as {commandFailed?:boolean}).commandFailed,undefined,'LID yang cocok ke PN di roster boleh mengontrol');
  assert.deepEqual(actionCalls,['stop','pause']);
  providerOnline=false;
  assert.equal((await request(controlsA,'GET',undefined,admin)).status,503);
  const unavailable=await command(groupA,caller,'/stop','provider-offline');
  assert.equal(unavailable.status,200);
  assert.equal((await unavailable.json() as {commandFailed:boolean}).commandFailed,true,'WAHA tidak tersedia harus gagal tertutup');
  assert.deepEqual(actionCalls,['stop','pause']);
  providerOnline=true;
  members=[{id:other,phone:other,aliases:[other]}];
  const removed=await command(groupA,caller,'/stop','former-member');
  assert.equal(removed.status,200);
  assert.equal((await removed.json() as {commandFailed:boolean}).commandFailed,true,'Anggota keluar tidak bisa mengontrol');
  assert.ok(observedGroups.includes(groupA));
 }finally{app.close();}
});

test('adapter WAHA membuang anggota left, menggabung PN dan LID, serta menolak mapping yang tidak berpasangan',async()=>{
 const config=loadConfig({ADMIN_PASSWORD:'password-long-enough',ENCRYPTION_KEY:'a'.repeat(64),WAHA_URL:'http://waha.test',WAHA_API_KEY:'mock-key',WAHA_SESSION:'carubra'});
 const groupId='120363430180897172@g.us', phone='62812345@c.us', lid='123456789@lid';
 const original=globalThis.fetch;
 let rows:unknown=[],mapping:unknown={lid,pn:'+62812345'};
 const paths:string[]=[];
 globalThis.fetch=async(input,init)=>{
  const url=String(input);paths.push(url);
  assert.equal(init?.method ?? 'GET','GET','Verifier tidak boleh mengirim pesan atau mengubah WAHA');
  assert.equal(new Headers(init?.headers).get('X-Api-Key'),'mock-key');
  if(url.includes('/participants/v2'))return Response.json(rows);
  if(url.includes('/lids/'))return Response.json(mapping);
  throw new Error('Endpoint WAHA tak dikenal');
 };
 try{
  const phoneRow={id:'62812345@s.whatsapp.net',pn:'+62812345',role:'member'};
  const lidRow={id:lid,pn:'+62812345',role:'member'};
  const leftRow={id:'999999999@lid',pn:'+62899999',role:'left'};
  for(const pair of [[phoneRow,lidRow],[lidRow,phoneRow]]){
   rows=[leftRow,...pair];
   assert.deepEqual(await getWahaGroupParticipants(config,groupId),[{id:lid,phone:'+62812345',aliases:[lid,phone]}]);
  }
  rows=[leftRow];
  assert.deepEqual(await getWahaGroupParticipants(config,groupId),[]);
  rows=[{id:'not-a-participant',role:'member'}];
  await assert.rejects(getWahaGroupParticipants(config,groupId),(error:unknown)=>error instanceof AppError&&error.status===503);
  assert.equal(await getWahaParticipantAlias(config,phone),lid);
  assert.equal(await getWahaParticipantAlias(config,lid),phone);
  mapping={lid:'222222222@lid',pn:'+62812345'};
  assert.equal(await getWahaParticipantAlias(config,lid),null,'Mapping LID yang tak cocok ditolak');
  mapping={lid,pn:'+62855555'};
  assert.equal(await getWahaParticipantAlias(config,phone),null,'Mapping PN yang tak cocok ditolak');
  assert.ok(paths.some(url=>url.endsWith('/lids/pn/62812345%40c.us')));
  assert.ok(paths.some(url=>url.endsWith('/lids/123456789%40lid')));
 }finally{globalThis.fetch=original;}
});

test('GET kontrol mempertahankan izin saat roster berganti PN-only/LID-only; izin usang dapat dihapus',async()=>{
 const groupId='120363430180897172@g.us',phone='62812345@c.us',lid='123456789@lid';
 const config=loadConfig({ADMIN_PASSWORD:'password-long-enough',ENCRYPTION_KEY:'a'.repeat(64),APP_ORIGIN:'http://127.0.0.1:3210',WHATSAPP_GROUP_IDS:groupId});
 let roster:Array<{id:string;phone:string|null;aliases:string[]}>=[{id:phone,phone:'+62812345',aliases:[phone]}];
 let aliases=new Map<string,string>([[phone,lid],[lid,phone]]);
 const app=createApp(config,new Store(':memory:'),{
  getGroupParticipants:async()=>roster,
  getParticipantAlias:async id=>aliases.get(id) ?? null
 });
 await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
 try{
  const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:config.origin,'Content-Type':'application/json'},body:JSON.stringify({password:config.password})});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie')!.split(';')[0];
  const endpoint=base+'/api/rooms/default/whatsapp/controls';
  const get=async()=>{
   const response=await fetch(endpoint+'?groupId='+encodeURIComponent(groupId),{headers:{Cookie:cookie}});
   assert.equal(response.status,200);
   return response.json() as Promise<{unmatchedPermissions:boolean;participants:Array<{id:string;allowed:boolean}>}>;
  };
  const put=async(participantIds:string[])=>fetch(endpoint,{method:'PUT',headers:{Origin:config.origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({groupId,participantIds})});
  assert.equal((await put([phone])).status,200);
  roster=[{id:lid,phone:null,aliases:[lid]}];
  assert.deepEqual(await get(),{groupId,unmatchedPermissions:false,participants:[{id:lid,phone:null,allowed:true}]});
  assert.equal((await put([lid])).status,200);
  roster=[{id:phone,phone:'+62812345',aliases:[phone]}];
  assert.deepEqual(await get(),{groupId,unmatchedPermissions:false,participants:[{id:phone,phone:'+62812345',allowed:true}]});
  aliases=new Map();
  assert.deepEqual(await get(),{groupId,unmatchedPermissions:true,participants:[{id:phone,phone:'+62812345',allowed:false}]});
  assert.equal((await put([])).status,200,'Izin usang bisa dibersihkan walau roster berubah');
  assert.deepEqual(await get(),{groupId,unmatchedPermissions:false,participants:[{id:phone,phone:'+62812345',allowed:false}]});
 }finally{app.close();}
});
