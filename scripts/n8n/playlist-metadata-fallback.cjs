const fs=require('fs'),assert=require('node:assert/strict');
const {api}=require('/tmp/api.cjs');
const before=JSON.parse(fs.readFileSync('/tmp/playlist-metadata-before.json'));
const w=structuredClone(before);
const validate=w.nodes.find(n=>n.name==='Validate requested playlist');assert.ok(validate);
validate.parameters.jsCode=String.raw`const c=$('Choose play or queue').first().json,r=$json,a=r.body??{};
const status=Number(r.statusCode??r.error?.httpCode??r.error?.statusCode??0);
const ok=!r.error&&status>=200&&status<300&&a.uri===c.targetUri;
const url='https://open.spotify.com/playlist/'+c.targetUri.split(':')[2];
const fallback=c.playMode==='play'&&[403,404].includes(status);
const playlist=ok?a:fallback?{uri:c.targetUri,name:'Playlist Spotify',owner:{display_name:'Nama playlist tidak tersedia melalui API'},external_urls:{spotify:url}}:a;
let reply='';
if(!ok&&!fallback){reply='Metadata playlist tidak dapat diakses Spotify (HTTP '+(status||'network')+'). Tidak ada playback/antrean yang diubah.';
 if([403,404].includes(status))reply+=' Playlist privat, personal, atau buatan Spotify dapat tidak tersedia melalui API. Untuk mencoba pemutaran langsung gunakan /playlist '+url+'. Command tersebut menggantikan playback aktif; keberhasilan tetap bergantung akses akun dan perangkat Spotify.';
 else reply+=' Coba lagi setelah akses Spotify pulih.';}
return [{json:{...c,playlist,playlistReady:ok||fallback,playlistMetadataUnavailable:fallback,reply}}];`;
const parse=w.nodes.find(n=>n.name==='Validate WhatsApp command');
parse.parameters.jsCode=parse.parameters.jsCode.replace('/playlist URL Spotify — putar playlist langsung; menggantikan playback aktif','/playlist URL Spotify — putar langsung, termasuk mencoba playlist personal; menggantikan playback aktif');
const context={targetUri:'spotify:playlist:37i9dQZF1EIYGUUyEXWkas',playMode:'play'};
const run=(status,mode='play')=>new Function('$','$json',validate.parameters.jsCode)(()=>({first:()=>({json:{...context,playMode:mode}})}),{statusCode:status,body:{error:{message:'Unavailable'}}})[0].json;
for(const status of [403,404]){assert.equal(run(status).playlistReady,true);assert.equal(run(status).playlist.uri,context.targetUri);assert.equal(run(status).playlistMetadataUnavailable,true);assert.equal(run(status,'queue').playlistReady,false);assert.match(run(status,'queue').reply,/\/playlist/);}
for(const status of [401,429,500])assert.equal(run(status).playlistReady,false);
fs.writeFileSync('/tmp/playlist-fixed.json',JSON.stringify({name:w.name,nodes:w.nodes,connections:w.connections,settings:w.settings,staticData:w.staticData}));
console.log('Tests passed: unavailable metadata can proceed only for direct playback; queue mode and API outages never mutate playback.');
if(process.argv.includes('--deploy'))(async()=>{const latest=await api('/workflows/'+w.id);assert.equal(latest.versionId,before.versionId,'Workflow changed since backup');const body=JSON.parse(fs.readFileSync('/tmp/playlist-fixed.json'));body.staticData=latest.staticData;await api('/workflows/'+w.id,'PUT',body);if(before.active)await api('/workflows/'+w.id+'/activate','POST',{});const saved=await api('/workflows/'+w.id);fs.writeFileSync('/tmp/playlist-metadata-after.json',JSON.stringify(saved));console.log(JSON.stringify({workflow:saved.id,active:saved.active}));})().catch(e=>{console.error(e.message);process.exit(1)});
