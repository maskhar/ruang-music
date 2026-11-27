import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.ts';
import { verifyWahaMessage } from '../server/waha.ts';
import { AppError } from '../server/types.ts';

const config = loadConfig({ADMIN_PASSWORD:'test-password-long-enough',ENCRYPTION_KEY:'a'.repeat(64),APP_ORIGIN:'https://dev.example.test',WAHA_URL:'http://waha.test/',WAHA_API_KEY:'test-secret',WAHA_SESSION:'carubra'});
const message = {groupId:'120363500000000123@g.us',session:'carubra',senderId:'628123@c.us',messageId:'wamid.test-1',text:'/hubungkan deadbeef'};

test('verifikasi WAHA mencocokkan pesan asli, pengirim, grup, dan command secara persis',async()=>{
 const original=globalThis.fetch;
 let requestedUrl='',requestedKey='';
 globalThis.fetch=async(input,init)=>{
  requestedUrl=String(input);requestedKey=new Headers(init?.headers).get('X-Api-Key')||'';
  return Response.json({id:message.messageId,from:message.groupId,fromMe:false,participant:message.senderId,body:message.text});
 };
 try {
  assert.equal(await verifyWahaMessage(config,message),true);
  assert.match(requestedUrl,/carubra\/chats\/120363500000000123%40g\.us\/messages\/wamid\.test-1\?downloadMedia=false$/);
  assert.equal(requestedKey,'test-secret');
 } finally {globalThis.fetch=original;}
});

test('verifikasi WAHA menolak sumber atau isi pesan yang berbeda dan tidak ditemukan',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({id:message.messageId,from:message.groupId,fromMe:false,participant:'628999@c.us',body:message.text});
 try {assert.equal(await verifyWahaMessage(config,message),false);} finally {globalThis.fetch=original;}
 globalThis.fetch=async()=>new Response(null,{status:404});
 try {assert.equal(await verifyWahaMessage(config,message),false);} finally {globalThis.fetch=original;}
});

test('verifikasi WAHA gagal tertutup ketika API tidak dapat memastikan sumber pesan',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async()=>new Response('unavailable',{status:503});
 try {await assert.rejects(verifyWahaMessage(config,message),(error:unknown)=>error instanceof AppError&&error.status===503);} finally {globalThis.fetch=original;}
});
