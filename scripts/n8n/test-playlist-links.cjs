const fs=require('fs'),assert=require('node:assert/strict'),{randomUUID}=require('crypto');
const {api,db}=require('/tmp/api.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let workflow;
(async()=>{
 const w=JSON.parse(fs.readFileSync('/tmp/playlist-fixed.json'));
 w.name='TEMP playlist URL validation';delete w.staticData;w.settings={executionOrder:'v1',saveDataSuccessExecution:'all',saveDataErrorExecution:'all'};
 const path='spotify-playlist-test-'+randomUUID();
 const trigger=w.nodes.find(n=>n.name==='WAHA Trigger');trigger.type='n8n-nodes-base.webhook';trigger.typeVersion=2;trigger.parameters={httpMethod:'POST',path,responseMode:'lastNode',options:{}};delete trigger.webhookId;
 w.connections['WAHA Trigger']={main:[[{node:'Validate WhatsApp command',type:'main',index:0}]]};
 const mock=(name,code)=>{const n=w.nodes.find(n=>n.name===name);assert.ok(n,name);n.type='n8n-nodes-base.code';n.typeVersion=2;n.parameters={jsCode:code};n.retryOnFail=false;delete n.credentials;};
 mock('Check playback before play',"return [{json:{is_playing:true,device:{id:'mock-device'}}}];");
 mock('Check available playback devices',"return [{json:{devices:[{id:'mock-device',is_active:true}]}}];");
 mock('Read requested playlist',"return [{json:{statusCode:200,body:{uri:'spotify:playlist:4ksUygfNi4swlzqnVMrcwA',name:'Test playlist',owner:{display_name:'Test owner'},external_urls:{spotify:'https://open.spotify.com/playlist/4ksUygfNi4swlzqnVMrcwA'}}}}];");
 mock('Read all playlist tracks',"const mode=$('WAHA Trigger').first().json.body.mode;return [{json:mode==='forbidden'?{statusCode:403,body:{error:{message:'Forbidden'}}}:{statusCode:200,body:{total:2,next:null,items:[{track:{uri:'spotify:track:one',name:'One',artists:[{name:'Test'}]}},{track:{uri:'spotify:track:two',name:'Two',artists:[{name:'Test'}]}}]}}}];");
 mock('Queue playlist track',"return [{json:{statusCode:204}}];");mock('Start requested playlist',"return [{json:{statusCode:204}}];");
 mock('Request metadata',"return [{json:{name:'Test playlist',owner:{display_name:'Test owner'}}}];");
 for(const n of w.nodes.filter(n=>n.type==='n8n-nodes-base.dataTable'))mock(n.name,'return $input.all();');
 mock('Reply WhatsApp','return $input.all();');
 mock('AI Agent',"throw new Error('Exact playlist URL must not reach AI');");
 // Disconnect AI tools: the exact URL branch must work without model access.
 for(const [name,c] of Object.entries(w.connections))if(c.ai_tool||c.ai_languageModel||c.ai_memory)delete w.connections[name];
 workflow=await api('/workflows','POST',w);await api('/workflows/'+workflow.id+'/activate','POST',{});
 for(let i=0;i<20;i++){if(db.prepare('SELECT 1 FROM webhook_entity WHERE workflowId=?').get(workflow.id))break;await sleep(250);}
 for(const mode of ['queue','forbidden','direct']){
  const text=(mode==='direct'?'/playlist ':'/play ')+'https://open.spotify.com/playlist/4ksUygfNi4swlzqnVMrcwA?si=test';
  const response=await fetch('http://127.0.0.1:5678/webhook/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode,session:'carubra',event:'message',payload:{from:'120363412435389448@g.us',participant:'628123@c.us',body:text,id:'test-'+mode}}),signal:AbortSignal.timeout(45000)});
  const result=await response.json();const executions=await api('/executions?workflowId='+workflow.id+'&limit=1');const e=await api('/executions/'+executions.data[0].id+'?includeData=true');
  assert.equal(e.status,'success',JSON.stringify({mode,node:e.data?.resultData?.lastNodeExecuted,error:e.data?.resultData?.error?.message}));
  const runs=e.data.resultData.runData;
  if(mode==='queue'){assert.equal(runs['Queue playlist track'].length,2);assert.match(result.reply,/2\/2 track/);assert.ok(!runs['Start requested playlist']);}
  if(mode==='forbidden'){assert.match(result.reply,/HTTP 403/);assert.match(result.reply,/\/playlist/);assert.ok(!runs['Queue playlist track']);assert.ok(!runs['Start requested playlist']);}
  if(mode==='direct'){assert.ok(runs['Start requested playlist']);assert.ok(!runs['Queue playlist track']);assert.match(result.reply,/Test playlist/);}
  assert.equal(result.chatId,'120363412435389448@g.us');console.log(JSON.stringify({mode,status:e.status,noRealPlaybackOrMessages:true}));
 }
})().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(async()=>{
 if(workflow){await api('/workflows/'+workflow.id+'/deactivate','POST',{});for(let i=0;i<20;i++){try{await api('/workflows/'+workflow.id,'DELETE');break;}catch(error){if(!error.message.startsWith('409'))throw error;await sleep(250);}}console.log('Temporary playlist workflow removed.');}
});
