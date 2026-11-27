// Run inside n8n after copying ignored development config to /tmp/dev-n8n-config.json.
const fs=require('fs'),assert=require('node:assert/strict'),{randomUUID}=require('crypto');
const {api}=require('/tmp/api.cjs');
(async()=>{
 const c=JSON.parse(fs.readFileSync('/tmp/dev-n8n-config.json'));
 const main=await api('/workflows/mMKGZXtIS2uvso8W');
 const list=await api('/workflows?limit=100');
 assert.ok(!list.data.some(w=>w.name==='Ruang Musik · DEVELOPMENT'),'Development workflow already exists');
 const nodes=structuredClone(main.nodes); const trigger=nodes.find(n=>n.name==='WAHA Trigger');const oldWebhook=trigger.webhookId;
 for(const node of nodes)node.id=randomUUID(); trigger.webhookId=randomUUID();
 const parser=nodes.find(n=>n.name==='Validasi grup dan peminta');
 parser.parameters.jsCode=`const event=$json.body??$json,p=event.payload??{}; if(event.session!==${JSON.stringify(c.session)}||event.event!=='message'||p.fromMe===true||p.hasMedia===true||!/^\\d+@g\\.us$/.test(p.from)||!/^\\d+@(?:c\\.us|s\\.whatsapp\\.net|lid)$/.test(p.participant??'')||!/^\\//.test(String(p.body??'').trim())||!p.id)return []; return [{json:{session:event.session,groupId:p.from,senderId:p.participant,messageId:p.id,text:String(p.body).trim(),requester:String(p._data?.notifyName??p.pushName??'Anggota WhatsApp').slice(0,60)}}];`;
 for(const g of c.groupIds)assert.equal(new Function('$json',parser.parameters.jsCode)({session:c.session,event:'message',payload:{from:g,participant:'0@c.us',id:'test',body:'/help'}}).length,1);
 assert.equal(new Function('$json',parser.parameters.jsCode)({session:c.session,event:'message',payload:{from:'0@c.us',participant:'0@c.us',id:'test',body:'/help'}}).length,0);
 const auth=await api('/credentials','POST',{name:'Ruang Musik API · DEVELOPMENT',type:'httpHeaderAuth',data:{name:'Authorization',value:'Bearer '+c.integrationToken}});
 const request=nodes.find(n=>n.name==='Request Ruang Musik');request.parameters.url='http://dev-spotify-player:3210/api/integrations/whatsapp';request.credentials.httpHeaderAuth={id:auth.id,name:auth.name};
 const formatter=nodes.find(n=>n.name==='Siapkan balasan aplikasi');
 formatter.parameters.jsCode=`const cmd=$('Validasi grup dan peminta').first().json, body=$json.body??$json, status=Number($json.statusCode??200);
 if(status<200||status>=300||body.duplicate===true||typeof body.reply!=='string'||!body.reply)return [];
 return [{json:{chatId:cmd.groupId,messageId:cmd.messageId,reply:body.reply}}];`;
 const reply=nodes.find(n=>n.name==='Reply WhatsApp');reply.parameters.url=c.wahaUrl.replace(/\/$/,'')+'/api/sendText';reply.parameters.jsonBody='={{ JSON.stringify({session:'+JSON.stringify(c.session)+',chatId:$json.chatId,text:$json.reply,reply_to:$json.messageId,linkPreview:false}) }}';
 const body={name:'Ruang Musik · DEVELOPMENT',nodes,connections:main.connections,settings:{executionOrder:'v1',saveDataSuccessExecution:'none',saveDataErrorExecution:'none'}};
 const created=await api('/workflows','POST',body);fs.writeFileSync('/tmp/dev-workflow-created.json',JSON.stringify(created));
 const health=await fetch('http://dev-spotify-player:3210/healthz');assert.equal(health.status,200);assert.equal((await health.json()).rooms,true);
 await api('/workflows/'+created.id+'/activate','POST',{});
 const sessionUrl=c.wahaUrl.replace(/\/$/,'')+'/api/sessions/'+encodeURIComponent(c.session);const headers={'X-Api-Key':c.wahaKey,'Content-Type':'application/json'};
 const beforeResponse=await fetch(sessionUrl,{headers});assert.equal(beforeResponse.status,200);const before=await beforeResponse.json();fs.writeFileSync('/tmp/dev-waha-session-before.json',JSON.stringify(before));
 const source=before.config.webhooks.find(h=>h.url.includes(oldWebhook)&&!h.url.includes('/webhook-test/'));assert.ok(source,'Production webhook route not found');
 const webhook={...source,url:source.url.replace(oldWebhook,trigger.webhookId),events:['message']};
 const updated=await fetch(sessionUrl,{method:'PUT',headers,body:JSON.stringify({config:{...before.config,webhooks:[...before.config.webhooks,webhook]}})});
 if(!updated.ok){await api('/workflows/'+created.id+'/deactivate','POST',{});throw Error('WAHA config update failed HTTP '+updated.status);}
 const after=await fetch(sessionUrl,{headers}).then(r=>r.json());assert.ok(after.config.webhooks.some(h=>h.url===webhook.url));assert.ok(before.config.webhooks.every(h=>after.config.webhooks.some(a=>a.url===h.url)));
 const prod=await api('/workflows/'+main.id);assert.equal(prod.versionId,main.versionId);assert.equal(prod.active,true);
 fs.writeFileSync('/tmp/dev-workflow-published.json',JSON.stringify(await api('/workflows/'+created.id)));
 console.log(JSON.stringify({developmentWorkflow:created.id,active:true,productionUnchanged:true,existingWebhooksPreserved:true,sessionStatus:after.status}));
})().catch(()=>{console.error('Development setup failed; inspect locally without publishing secrets.');process.exitCode=1}).finally(()=>{try{fs.unlinkSync('/tmp/dev-n8n-config.json')}catch{}});
