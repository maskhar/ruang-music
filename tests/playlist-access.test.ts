import test from 'node:test';
import assert from 'node:assert/strict';
import { Spotify, spotifyReference } from '../server/spotify.ts';
import { Store } from '../server/database.ts';
import { loadConfig } from '../server/config.ts';
import { AppError } from '../server/types.ts';
const id='4ksUygfNi4swlzqnVMrcwA';
test('URL playlist pengguna mempertahankan ID tanpa query si',()=>{assert.deepEqual(spotifyReference(`https://open.spotify.com/playlist/${id}?si=zGfrScbuSyOYeIxkcEsrFg`),{type:'playlist',id});});
test('403 daftar lagu dibedakan dari metadata dan Premium; tidak ada mutation',async()=>{const store=new Store(':memory:');const spotify=new Spotify(loadConfig({ADMIN_PASSWORD:'test-password-123456',ENCRYPTION_KEY:'a'.repeat(64)}),store);const paths:string[]=[];spotify.api=async(path,method='GET')=>{assert.equal(method,'GET');paths.push(path);if(path===`/playlists/${id}`)return {uri:`spotify:playlist:${id}`,name:'Playlist'};throw new AppError('Forbidden',403);};try{await assert.rejects(()=>spotify.resolve(`https://open.spotify.com/playlist/${id}`),(e:unknown)=>e instanceof AppError&&e.status===403&&e.message.includes('daftar lagunya')&&e.message.includes('antrean track'));assert.equal(paths.length,2);}finally{store.close();}});
