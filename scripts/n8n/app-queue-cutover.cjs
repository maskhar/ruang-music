const fs=require('fs'),assert=require('node:assert/strict'),{randomUUID}=require('crypto');
const {api}=require('/tmp/api.cjs');
const config=JSON.parse(fs.readFileSync('/tmp/app-queue-config.json'));
const before=JSON.parse(fs.readFileSync('/tmp/mMKGZXtIS2uvso8W-app-queue-before.json'));
const monitorBefore=JSON.parse(fs.readFileSync('/tmp/WJhwejxEcPWJpG6o-app-queue-before.json'));
const trigger=structuredClone(before.nodes.find(n=>n.name==='WAHA Trigger'));assert.ok(trigger);
const allowed=config.groupIds;assert.ok(allowed.length&&allowed.every(id=>/^\d+@g\.us$/.test(id)));
const parser={id:randomUUID(),name:'Validasi grup dan peminta',type:'n8n-nodes-base.code',typeVersion:2,position:[0,0],parameters:{jsCode:`const event=$json.body??$json,p=event.payload??{};
if(event.session!=='carubra'||event.event!=='message'||p.fromMe===true||p.hasMedia===true||!${JSON.stringify(allowed)}.includes(p.from)||!/^\\d+@(?:c\\.us|s\\.whatsapp\\.net|lid)$/.test(p.participant??'')||!/^\\//.test(String(p.body??'').trim())||!p.id)return [];
return [{json:{groupId:p.from,senderId:p.participant,messageId:p.id,text:String(p.body).trim(),requester:String(p._data?.notifyName??p.pushName??'Anggota WhatsApp').slice(0,60)}}];`}};
const request={id:randomUUID(),name:'Request Ruang Musik',type:'n8n-nodes-base.httpRequest',typeVersion:4.2,position:[240,0],retryOnFail:false,onError:'continueRegularOutput',parameters:{method:'POST',url:'http://spotify-player:3210/api/integrations/whatsapp',authentication:'genericCredentialType',genericAuthType:'httpHeaderAuth',sendBody:true,specifyBody:'json',jsonBody:'={{ JSON.stringify($json) }}',options:{timeout:60000,response:{response:{fullResponse:true,neverError:true}}}},credentials:{httpHeaderAuth:{id:'TO_CONFIGURE',name:'Ruang Musik API · carubra'}}};
const format={id:randomUUID(),name:'Siapkan balasan aplikasi',type:'n8n-nodes-base.code',typeVersion:2,position:[480,0],parameters:{jsCode:`const c=$('Validasi grup dan peminta').first().json,r=$json,b=r.body??r;
if(b.duplicate===true)return [];
const reply=typeof b.reply==='string'?b.reply:typeof b.error==='string'?b.error:r.statusCode===429?'Terlalu banyak command. Tunggu sebentar lalu periksa /queue.':'Server antrean belum dapat mengonfirmasi command. Periksa /queue sebelum mengirim request lagi.';
return [{json:{chatId:c.groupId,messageId:c.messageId,reply}}];`}};
const reply=structuredClone(before.nodes.find(n=>n.name==='Reply WhatsApp'));assert.ok(reply);
reply.position=[720,0];reply.retryOnFail=false;
reply.parameters.jsonBody="={{ JSON.stringify({session:'carubra',chatId:$json.chatId,text:$json.reply,reply_to:$json.messageId,linkPreview:false}) }}";
trigger.position=[-240,0];
const outputIndex=before.connections[trigger.name].main.findIndex(row=>row.some(edge=>edge.node==='Validate WhatsApp command'));assert.ok(outputIndex>=0);
const body={name:'Ruang Musik · Antrean aplikasi · carubra',nodes:[trigger,parser,request,format,reply],connections:{[trigger.name]:{main:Array.from({length:outputIndex+1},(_,i)=>i===outputIndex?[{node:parser.name,type:'main',index:0}]:[])},[parser.name]:{main:[[{node:request.name,type:'main',index:0}]]},[request.name]:{main:[[{node:format.name,type:'main',index:0}]]},[format.name]:{main:[[{node:reply.name,type:'main',index:0}]]}},settings:{executionOrder:'v1',saveDataSuccessExecution:'none',saveDataErrorExecution:'none'}};
for(const group of allowed){const result=new Function('$json',parser.parameters.jsCode)({session:'carubra',event:'message',payload:{from:group,participant:'628123@c.us',id:'id',body:'/play Judul'}});assert.equal(result[0].json.groupId,group);}
assert.equal(new Function('$json',parser.parameters.jsCode)({session:'carubra',event:'message',payload:{from:'628123@c.us',participant:'628123@c.us',id:'id',body:'/play Judul'}}).length,0);
fs.writeFileSync('/tmp/app-queue-proposed.json',JSON.stringify(body));
console.log('Adapter prepared: original webhook, allowed groups, no direct Spotify nodes.');
if(process.argv.includes('--deploy'))(async()=>{
 const latest=await api('/workflows/'+before.id);assert.equal(latest.versionId,before.versionId,'Main workflow changed since backup');
 const health=await fetch('http://spotify-player:3210/healthz').then(r=>r.json());assert.equal(health.queueMode,'application','Deploy application queue server before cutover');
 const monitor=await api('/workflows/'+monitorBefore.id);assert.equal(monitor.versionId,monitorBefore.versionId,'Monitor changed since backup');
 const auth=await api('/credentials','POST',{name:'Ruang Musik API · carubra',type:'httpHeaderAuth',data:{name:'Authorization',value:'Bearer '+config.integrationToken}});
 request.credentials.httpHeaderAuth.id=auth.id;
 // Verify the protected app path before switching the production webhook.
 const check=await fetch('http://spotify-player:3210/api/integrations/whatsapp',{method:'POST',headers:{Authorization:'Bearer '+config.integrationToken,'Content-Type':'application/json'},body:JSON.stringify({groupId:allowed[0],senderId:'0@c.us',messageId:'cutover-health-'+randomUUID(),text:'/help'}),signal:AbortSignal.timeout(10000)});
 const checkBody=await check.json();assert.equal(check.status,200);assert.match(checkBody.reply,/antrean aplikasi/);
 try{if(monitor.active)await api('/workflows/'+monitor.id+'/deactivate','POST',{});body.staticData=latest.staticData;await api('/workflows/'+before.id,'PUT',body);if(before.active)await api('/workflows/'+before.id+'/activate','POST',{});}
 catch(error){await api('/workflows/'+before.id,'PUT',{name:before.name,nodes:before.nodes,connections:before.connections,settings:before.settings,staticData:latest.staticData});if(before.active)await api('/workflows/'+before.id+'/activate','POST',{});if(monitor.active)await api('/workflows/'+monitor.id+'/activate','POST',{});throw error;}
 const saved=await api('/workflows/'+before.id),savedMonitor=await api('/workflows/'+monitor.id);
 fs.writeFileSync('/tmp/app-queue-published.json',JSON.stringify(saved));console.log(JSON.stringify({main:saved.id,active:saved.active,nodeCount:saved.nodes.length,legacyMonitorActive:savedMonitor.active,webhookPreserved:saved.nodes[0].webhookId===trigger.webhookId}));
 try { fs.unlinkSync('/tmp/app-queue-config.json'); } catch { console.log('Remove the temporary config file as its owner after deployment.'); }
})().catch(error=>{console.error(error.message);process.exit(1)});
