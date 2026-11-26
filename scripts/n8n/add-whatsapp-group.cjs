const fs=require('fs'),assert=require('node:assert/strict');
const {api}=require('/tmp/api.cjs');
const old='120363430180897172@g.us', added='120363412435389448@g.us', groups=[old,added];
const node=(w,name)=>{const n=w.nodes.find(n=>n.name===name);assert.ok(n,name);return n;};
const replace=(text,from,to)=>{assert.ok(text.includes(from),'Expected source missing: '+from);return text.replace(from,to);};
(async()=>{
 const ids=['mMKGZXtIS2uvso8W','WJhwejxEcPWJpG6o'];const workflows=[];
 for(const id of ids){const w=await api('/workflows/'+id);const backup=JSON.parse(fs.readFileSync('/tmp/'+id+'-groups-before.json'));assert.equal(w.versionId,backup.versionId,'Workflow changed since backup');workflows.push(w);}
 const [main,monitor]=workflows;
 const parser=node(main,'Validate WhatsApp command');parser.parameters.jsCode=replace(parser.parameters.jsCode,`const allowedGroup='${old}';`,`const allowedGroups=${JSON.stringify(groups)};`);parser.parameters.jsCode=replace(parser.parameters.jsCode,'chatId!==allowedGroup','!allowedGroups.includes(chatId)');
 const format=node(main,'Format AI reply');format.parameters.jsCode=replace(format.parameters.jsCode,`c.chatId!=='${old}'`,`!${JSON.stringify(groups)}.includes(c.chatId)`);
 const reply=node(main,'Reply WhatsApp');reply.parameters.jsonBody=replace(reply.parameters.jsonBody,`chatId:'${old}'`,'chatId:$json.chatId');
 const matching=node(monitor,'Match playback transition');matching.parameters.jsCode=replace(matching.parameters.jsCode,`r.groupId==='${old}'`,`${JSON.stringify(groups)}.includes(r.groupId)`);
 const notify=node(monitor,'Notify requester');notify.parameters.jsonBody=replace(notify.parameters.jsonBody,`chatId:'${old}'`,'chatId:$json.groupId');
 for(const w of workflows)for(const n of w.nodes)if(n.type==='n8n-nodes-base.stickyNote')n.parameters.content=n.parameters.content.replaceAll(old,groups.join(', '));
 const parse=(group,participant='628123@c.us')=>new Function('$json',parser.parameters.jsCode)({session:'carubra',event:'message',payload:{from:group,participant,body:'/help',id:'test-id',fromMe:false}});
 for(const group of groups){const result=parse(group);assert.equal(result[0].json.chatId,group);const send=new Function('$json','return ('+reply.parameters.jsonBody.slice(3,-2).trim()+')')({...result[0].json,reply:'Test'});assert.equal(JSON.parse(send).chatId,group);const body=new Function('$json','return ('+notify.parameters.jsonBody.slice(3,-2).trim()+')')({groupId:group,senderId:'628123@c.us',messageId:'test-id',title:'Test',artist:'Test',url:'https://open.spotify.com'});assert.equal(JSON.parse(body).chatId,group);}
 assert.equal(parse('other@g.us').length,0);assert.equal(parse('628123@c.us').length,0);assert.equal(parse(added,'').length,0);
 const request={id:1,status:'pending',groupId:added,senderId:'628123@c.us',uri:'spotify:track:test',queuedAt:Date.now()-5000,mode:'queue'};const now=Date.now();const player={uri:request.uri,progress:1000,duration:200000,playing:true,observedAt:now};const state={id:1,uri:'spotify:track:previous',observedAt:now-10000,version:'{}'};
 const output=new Function('$','$input','$execution',matching.parameters.jsCode)(name=>({first:()=>({json:name==='Validate monitor player'?player:state})}),{all:()=>[{json:request}]},{id:'test'});assert.equal(output[0].json.request.groupId,added);
 for(const w of workflows){fs.writeFileSync('/tmp/'+w.id+'-groups-proposed.json',JSON.stringify({name:w.name,nodes:w.nodes,connections:w.connections,settings:w.settings,staticData:w.staticData}));}
 console.log('Tests passed: both groups, DM rejection, participant validation, replies and notifications retain source group. No messages sent.');
 if(process.argv.includes('--deploy'))for(const w of [...workflows].reverse()){const latest=await api('/workflows/'+w.id);assert.equal(latest.versionId,w.versionId);const body=JSON.parse(fs.readFileSync('/tmp/'+w.id+'-groups-proposed.json'));body.staticData=latest.staticData;await api('/workflows/'+w.id,'PUT',body);if(w.active)await api('/workflows/'+w.id+'/activate','POST',{});const saved=await api('/workflows/'+w.id);console.log(JSON.stringify({id:saved.id,active:saved.active}));}
})().catch(e=>{console.error(e.message);process.exit(1)});
