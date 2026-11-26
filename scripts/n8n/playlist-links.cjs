const fs=require('fs'),assert=require('node:assert/strict'),{randomUUID}=require('crypto');
const {api}=require('/tmp/api.cjs');
const before=JSON.parse(fs.readFileSync('/tmp/playlist-before.json'));
const w=structuredClone(before);
const find=name=>{const n=w.nodes.find(n=>n.name===name);assert.ok(n,name);return n;};
const parser=find('Validate WhatsApp command');
let code=parser.parameters.jsCode;
code=code.replace("play:'ai',queue:","playlist:'playAuto',play:'ai',queue:").replace("let targetUri='';","let targetUri='', forcePlaylistPlay=false;");
const marker="if(cmd==='play'&&!targetUri";
assert.ok(code.includes(marker));
const extra=String.raw`const playlistRef=clean.match(/^(?:spotify:playlist:([A-Za-z0-9]{22})|https:\/\/open\.spotify\.com\/(?:intl-[a-z]+\/)?playlist\/([A-Za-z0-9]{22})\/?(?:[?#][^\s]*)?)$/i);
if((cmd==='play'||cmd==='playlist')&&playlistRef){targetUri='spotify:playlist:'+(playlistRef[1]??playlistRef[2]);action='playAuto';forcePlaylistPlay=cmd==='playlist';}
if(cmd==='playlist'&&!playlistRef)error='Contoh: /playlist https://open.spotify.com/playlist/ID — putar playlist langsung, menggantikan playback aktif.';
`;
code=code.replace(marker,extra+marker).replace('arg,targetUri,chatInput','arg,targetUri,forcePlaylistPlay,chatInput');
code=code.replace('/play URL Spotify — track atau album;', '/play URL Spotify — track, album, atau playlist;').replace('/play playlist galau — pilih dan putar playlist', '/play playlist galau — pilih dan putar playlist\\n/playlist URL Spotify — putar playlist langsung; menggantikan playback aktif');
parser.parameters.jsCode=code;
const choose=find('Choose play or queue');
choose.parameters.jsCode=choose.parameters.jsCode.replace('const playing=r.is_playing===true;', 'const playing=r.is_playing===true&&c.forcePlaylistPlay!==true;');
const playTool=find('Play playlist now');
playTool.type='n8n-nodes-base.httpRequestTool';playTool.typeVersion=4.2;
playTool.parameters={toolDescription:'Play an explicitly requested Spotify playlist using its exact context URI. Requires an active Spotify device. Never use a playlist URI as a track URI. Do not retry mutations. Inspect HTTP status before reporting success.',method:'PUT',url:'https://api.spotify.com/v1/me/player/play',authentication:'predefinedCredentialType',nodeCredentialType:'spotifyOAuth2Api',sendBody:true,specifyBody:'json',jsonBody:"={{ (() => { const uri=$fromAI('Playlist_URI','Exact spotify:playlist:ID from Spotify search or user URL','string').trim(); if(!/^spotify:playlist:[A-Za-z0-9]{22}$/.test(uri)) throw new Error('Playlist URI tidak valid'); return JSON.stringify({context_uri:uri}); })() }}",options:{timeout:8000,response:{response:{fullResponse:true,neverError:true}}}};
const originals=w.nodes.filter(n=>/album/i.test(n.name)&&!['Get an album in Spotify','Search albums by keyword in Spotify'].includes(n.name));
const rename=s=>s.replaceAll('album','playlist').replaceAll('Album','Playlist');
const mapping=Object.fromEntries(originals.map(n=>[n.name,rename(n.name)]));
for(const original of originals){
  const n=JSON.parse(rename(JSON.stringify(original)));n.id=randomUUID();n.position=[original.position[0],original.position[1]+1700];w.nodes.push(n);
  if(w.connections[original.name]){const c=structuredClone(w.connections[original.name]);for(const rows of Object.values(c))for(const edges of rows)for(const edge of edges)edge.node=mapping[edge.node]||edge.node;w.connections[n.name]=c;}
}
const metadata=find('Read requested playlist');
metadata.retryOnFail=false;metadata.parameters.options.response.response.neverError=true;
const read=find('Read all playlist tracks');
read.type='n8n-nodes-base.httpRequest';read.typeVersion=4.2;read.credentials=structuredClone(metadata.credentials);read.retryOnFail=false;read.onError='continueRegularOutput';read.alwaysOutputData=true;
read.parameters={url:"={{ 'https://api.spotify.com/v1/playlists/'+$json.targetUri.split(':')[2]+'/tracks' }}",authentication:'predefinedCredentialType',nodeCredentialType:'spotifyOAuth2Api',sendQuery:true,queryParameters:{parameters:[{name:'limit',value:'50'}]},options:{timeout:8000,response:{response:{fullResponse:true,neverError:true}},pagination:{pagination:{paginationMode:'updateAParameterInEachRequest',parameters:{parameters:[{type:'qs',name:'offset',value:'={{ $pageCount * 50 }}'}]},paginationCompleteWhen:'other',completeExpression:'={{ !$response.body.next || $response.statusCode >= 400 }}',limitPagesFetched:true,maxRequests:5}}}};
find('Prepare playlist tracks').parameters.jsCode=String.raw`const c=$('Validate requested playlist').first().json,pages=$input.all().map(i=>i.json);
const failed=pages.find(r=>r.error||Number(r.statusCode)<200||Number(r.statusCode)>=300);
if(failed){const status=failed.statusCode??'network';return [{json:{...c,playlistHasTracks:false,playlistQueueError:'Daftar lagu playlist tidak dapat dibaca (HTTP '+status+'). Tidak ada antrean yang diubah.'+(Number(status)===403?' Spotify membatasi akses daftar lagu playlist ini. Untuk memutar langsung gunakan /playlist '+(c.playlist.external_urls?.spotify??'https://open.spotify.com/playlist/'+c.targetUri.split(':')[2])+'. Command itu menggantikan playback aktif.':'')}}];}
const bodies=pages.map(p=>p.body??p);const rows=bodies.flatMap(p=>p.items??[]);
if(bodies.some(p=>Number(p.total)>200)||rows.length>200||bodies.at(-1)?.next)return [{json:{...c,playlistHasTracks:false,playlistQueueError:'Maksimal 200 item per playlist. Tidak ada antrean yang diubah.'}}];
const tracks=rows.map(r=>r.item??r.track).filter(t=>t?.uri?.startsWith('spotify:track:')&&t.is_playable!==false&&!t.is_local);
if(!tracks.length)return [{json:{...c,playlistHasTracks:false,playlistQueueError:'Playlist tidak memiliki track yang tersedia untuk ditambahkan.'}}];
return tracks.map((track,index)=>({json:{...c,playlistHasTracks:true,playlistCount:tracks.length,playlistSkipped:rows.length-tracks.length,track,index}}));`;
for(const name of ['Playlist start result','Playlist queue summary']){const n=find(name);n.parameters.jsCode=n.parameters.jsCode.replace("(c.playlist.artists??[]).map(a=>a.name).join(', ')","(c.playlist.owner?.display_name??'Playlist Spotify')");}
w.connections['Playback check succeeded'].main[0]=[{node:'Is exact playlist request',type:'main',index:0}];
w.connections['Is exact playlist request'].main[1]=[{node:'Is exact album request',type:'main',index:0}];
const sample='https://open.spotify.com/playlist/4ksUygfNi4swlzqnVMrcwA?si=zGfrScbuSyOYeIxkcEsrFg';
const parse=(text,group='120363412435389448@g.us')=>new Function('$json',parser.parameters.jsCode)({session:'carubra',event:'message',payload:{from:group,participant:'628123@c.us',body:text,id:'test-id'}})[0]?.json;
for(const link of [sample,'spotify:playlist:4ksUygfNi4swlzqnVMrcwA','https://open.spotify.com/intl-id/playlist/4ksUygfNi4swlzqnVMrcwA?si=test']){const p=parse('/play '+link);assert.equal(p.targetUri,'spotify:playlist:4ksUygfNi4swlzqnVMrcwA');assert.equal(p.action,'playAuto');assert.equal(p.forcePlaylistPlay,false);}
assert.equal(parse('/playlist '+sample).forcePlaylistPlay,true);assert.equal(parse('/playlist nope').action,'help');assert.equal(parse('/play '+sample,'other@g.us'),undefined);
const context={...parse('/play '+sample),playlist:{name:'Test',external_urls:{spotify:sample}}};
const prep=(status,body)=>new Function('$','$input',find('Prepare playlist tracks').parameters.jsCode)(()=>({first:()=>({json:context})}),{all:()=>[{json:{statusCode:status,body}}]});
assert.equal(prep(403,{})[0].json.playlistHasTracks,false);assert.match(prep(403,{})[0].json.playlistQueueError,/\/playlist/);assert.equal(prep(200,{total:201,items:[]})[0].json.playlistHasTracks,false);
assert.deepEqual(prep(200,{total:2,items:[{track:{uri:'spotify:track:one',name:'One'}},{item:{uri:'spotify:track:two',name:'Two'}}],next:null}).map(x=>x.json.track.name),['One','Two']);
const chooseMode=force=>new Function('$','$json',choose.parameters.jsCode)(name=>({first:()=>({json:name==='Validate WhatsApp command'?{...context,forcePlaylistPlay:force}:{is_playing:true,device:{id:'device'}}})}),{devices:[{id:'device',is_active:true}]})[0].json.playMode;
assert.equal(chooseMode(false),'queue');assert.equal(chooseMode(true),'play');
const startResult=status=>new Function('$','$json',find('Playlist start result').parameters.jsCode)(()=>({first:()=>({json:context})}),{statusCode:status,body:{error:{message:'Denied'}}})[0].json;
assert.equal(startResult(403).recordRequest,false);assert.equal(startResult(204).recordRequest,true);
const names=new Set(w.nodes.map(n=>n.name));for(const c of Object.values(w.connections))for(const rows of Object.values(c))for(const edges of rows)for(const edge of edges)assert.ok(names.has(edge.node),'Dangling connection '+edge.node);
for(const n of w.nodes)if(n.type==='n8n-nodes-base.code')new Function(n.parameters.jsCode);
fs.writeFileSync('/tmp/playlist-fixed.json',JSON.stringify({name:w.name,nodes:w.nodes,connections:w.connections,settings:w.settings,staticData:w.staticData}));
console.log('Playlist tests passed: URLs/URI, both modes, 403 no mutation, track order, limit and graph. No playback/messages sent.');
if(process.argv.includes('--deploy'))(async()=>{const latest=await api('/workflows/'+w.id);assert.equal(latest.versionId,before.versionId,'Workflow changed since backup');const body=JSON.parse(fs.readFileSync('/tmp/playlist-fixed.json'));body.staticData=latest.staticData;await api('/workflows/'+w.id,'PUT',body);if(before.active)await api('/workflows/'+w.id+'/activate','POST',{});const saved=await api('/workflows/'+w.id);console.log(JSON.stringify({workflow:saved.id,active:saved.active,nodes:saved.nodes.length}));})().catch(e=>{console.error(e.message);process.exit(1)});
