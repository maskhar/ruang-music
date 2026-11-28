import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/app.ts';
import {loadConfig} from '../server/config.ts';
import {inviteCodeFromUrl,getWahaJoinInfo,joinWahaGroup} from '../server/waha.ts';
import {AppError} from '../server/types.ts';

test('join WAHA dari invite valid: cek grup, join tanpa mengikat, tunggu /hubungkan',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'ruang-join-wa-'));
 const config=loadConfig({ADMIN_PASSWORD:'password-long-enough',ENCRYPTION_KEY:'a'.repeat(64),APP_ORIGIN:'http://127.0.0.1:3210',DATA_DIR:folder,WAHA_URL:'http://waha.test',WAHA_API_KEY:'mock-key',WAHA_SESSION:'carubra',INTEGRATION_TOKEN:'mock-integration',WHATSAPP_BLOCKED_GROUP_IDS:'120363500000000999@g.us'});
 const group='120363500000000123@g.us';
 const blocked='120363500000000999@g.us';
 let nextInfo={groupId:group,groupName:'Grup uji',requiresApproval:false};
 let nextStatus:'joined'|'already_member'|'pending'='joined';
 const seenCodes:string[]=[];
 const joinedCodes:string[]=[];
 const app=createApp(config,undefined,{
  verifyPairingMessage:async()=>true,
  getJoinInfo:async(code:string)=>{seenCodes.push(code);return nextInfo;},
  joinGroup:async(code:string)=>{joinedCodes.push(code);return nextStatus;}
 });
 await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
 const request=(path:string,method='GET',body?:unknown,cookie='')=>fetch(base+path,{method,headers:{Origin:config.origin,Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const inviteUrl='https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv';
 try {
  const login=await request('/api/login','POST',{password:config.password});assert.equal(login.status,200);
  const admin=login.headers.get('set-cookie')!.split(';')[0];
  const create=async(name:string)=>{
   const response=await request('/api/rooms','POST',{name},admin);assert.equal(response.status,201);
   return (await response.json() as {id:string}).id;
  };
  const room=await create('Ruang bergabung'),other=await create('Ruang lain');
  const link=(id:string,url=inviteUrl,cookie=admin)=>request(`/api/rooms/${id}/whatsapp/join`,'POST',{inviteUrl:url},cookie);
  const invite=async(role:'member'|'operator',email:string)=>{
   const created=await request(`/api/rooms/${room}/members`,'POST',{email,name:role,role},admin);assert.equal(created.status,201);
   const token=new URL((await created.json() as {inviteUrl:string}).inviteUrl).searchParams.get('invite');assert.ok(token);
   assert.equal((await request('/api/invitations/accept','POST',{token,password:'member-long-password'})).status,200);
   const response=await request('/api/login','POST',{email,password:'member-long-password'});assert.equal(response.status,200);
   return response.headers.get('set-cookie')!.split(';')[0];
  };
  const member=await invite('member','listener@room.test');
  const operator=await invite('operator','operator@room.test');
  assert.equal((await link(room,inviteUrl,member)).status,403);
  assert.equal(seenCodes.length,0,'Anggota tidak memanggil WAHA');
  for(const invalid of ['https://evil.test/chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv','http://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv','https://chat.whatsapp.com.evil.test/AbCdEfGhIjKlMnOpQrStUv','https://chat.whatsapp.com/invite/AbCdEfGhIjKlMnOpQrStUv','https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv#extra','https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv?token=secret','https://chat.whatsapp.com/../../evil']) {
   assert.equal((await link(room,invalid)).status,400,`Harus menolak URL invite: ${invalid}`);
  }
  assert.equal(seenCodes.length,0,'URL tidak valid tidak menghubungi WAHA');
  const joined=await link(room);
  assert.equal(joined.status,200);
  assert.deepEqual(await joined.json(),{status:'joined',groupName:'Grup uji'});
  assert.deepEqual(seenCodes,['AbCdEfGhIjKlMnOpQrStUv']);
  assert.deepEqual(joinedCodes,['AbCdEfGhIjKlMnOpQrStUv']);
  const cards=(await (await request('/api/rooms','GET',undefined,admin)).json() as {rooms:Array<{id:string,groupId:string|null}>}).rooms;
  assert.equal(cards.find(card=>card.id===room)?.groupId,null,'Join tidak langsung bind grup');
  nextStatus='already_member';
  assert.deepEqual(await (await link(room)).json(),{status:'already_member',groupName:'Grup uji'});
  assert.deepEqual(await (await link(room,inviteUrl,operator)).json(),{status:'already_member',groupName:'Grup uji'});
  nextStatus='pending';
  nextInfo={...nextInfo,requiresApproval:true};
  assert.deepEqual(await (await link(room)).json(),{status:'pending',groupName:'Grup uji'});
  nextInfo={...nextInfo,groupId:blocked};
  const before=joinedCodes.length;
  assert.equal((await link(room)).status,403);
  assert.equal(joinedCodes.length,before,'Grup terlarang tidak memicu WAHA join');
  nextInfo={...nextInfo,groupId:'0@g.us'};
  assert.equal((await link(room)).status,403);
  assert.equal(joinedCodes.length,before);
  nextInfo={...nextInfo,groupId:group};
  const pairing=await request(`/api/rooms/${other}/pairing`,'GET',undefined,admin);
  const code=(await pairing.json() as {code:string}).code;
  const paired=await fetch(base+'/api/integrations/whatsapp',{method:'POST',headers:{Authorization:'Bearer '+config.integrationToken,'Content-Type':'application/json'},body:JSON.stringify({groupId:group,session:'carubra',senderId:'628123@c.us',messageId:'pair-other',text:'/hubungkan '+code})});
  assert.equal(paired.status,200);
  assert.equal((await link(room)).status,409);
  assert.equal(joinedCodes.length,before);
  assert.equal((await link(other)).status,409,'Ruang yang sudah memiliki grup tidak dapat join ulang');
  assert.equal(joinedCodes.length,before);
 } finally {app.close();rmSync(folder,{recursive:true,force:true});}
});

test('parser URL undangan membatasi hostname, protokol, kode, dan parameter sensitif',()=>{
 const code='AbCdEfGhIjKlMnOpQrStUv';
 assert.equal(inviteCodeFromUrl(' https://chat.whatsapp.com/'+code+' '),code);
 for(const invalid of ['http://chat.whatsapp.com/'+code,'https://chat.whatsapp.com.evil.test/'+code,'https://chat.whatsapp.com/invite/'+code,'https://chat.whatsapp.com/'+code+'#fragment','https://chat.whatsapp.com/short']){
  assert.throws(()=>inviteCodeFromUrl(invalid),(error:unknown)=>error instanceof AppError&&error.status===400);
 }
});

test('WAHA join-info membaca ID gid, menolak metadata palsu, dan tidak menautkan grup',async()=>{
 const config=loadConfig({ADMIN_PASSWORD:'password-long-enough',ENCRYPTION_KEY:'a'.repeat(64),WAHA_URL:'http://waha.test',WAHA_API_KEY:'mock-key'});
 const original=globalThis.fetch;
 let result:unknown={gid:{_serialized:'120363500000000123@g.us'},subject:'Grup WAHA',membershipApprovalMode:true};
 globalThis.fetch=async()=>Response.json(result);
 try {
  assert.deepEqual(await getWahaJoinInfo(config,'AbCdEfGhIjKlMnOpQrStUv'),{groupId:'120363500000000123@g.us',groupName:'Grup WAHA',requiresApproval:true});
  result={gid:'628123@c.us',subject:'Salah'};
  await assert.rejects(getWahaJoinInfo(config,'AbCdEfGhIjKlMnOpQrStUv'),(error:unknown)=>error instanceof AppError&&error.status===502);
 } finally {globalThis.fetch=original;}
});

test('WAHA join mengenali anggota saat ini, menolak hasil grup berbeda, dan pending tanpa konfirmasi keanggotaan',async()=>{
 const config=loadConfig({ADMIN_PASSWORD:'password-long-enough',ENCRYPTION_KEY:'a'.repeat(64),WAHA_URL:'http://waha.test',WAHA_API_KEY:'mock-key',WAHA_SESSION:'carubra'});
 const original=globalThis.fetch;
 const info={groupId:'120363500000000123@g.us',groupName:'Grup WAHA',requiresApproval:false};
 const code='AbCdEfGhIjKlMnOpQrStUv';
 let member=true,joinedId=info.groupId,joinRequests=0;
 globalThis.fetch=async(input,init)=>{
  const url=String(input);
  if(url.endsWith('/api/sessions/carubra'))return Response.json({me:{id:'628123@c.us'}});
  if(url.includes('/participants/v2'))return Response.json(member?[{id:'628123@c.us'}]:[]);
  if(url.endsWith('/groups/join')&&init?.method==='POST'){
   joinRequests++;assert.deepEqual(JSON.parse(String(init.body)),{code});return Response.json({id:joinedId});
  }
  throw new Error('Unexpected mocked WAHA URL: '+url);
 };
 try {
  assert.equal(await joinWahaGroup(config,code,info),'already_member');assert.equal(joinRequests,0);
  member=false;assert.equal(await joinWahaGroup(config,code,info),'pending');assert.equal(joinRequests,1);
  joinedId='120363500000000999@g.us';
  await assert.rejects(joinWahaGroup(config,code,info),(error:unknown)=>error instanceof AppError&&error.status===502);
 } finally {globalThis.fetch=original;}
});
