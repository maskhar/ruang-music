import { createHash } from 'node:crypto';
import type { Config } from './config.ts';
import { AppError, type Track } from './types.ts';
import { Store } from './database.ts';
import { decrypt, encrypt } from './crypto.ts';
type Tokens = { access_token: string; refresh_token: string; expiresAt: number; scope: string };
export const scopes = 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state';
export function spotifyReference(input: string): { type: 'track' | 'album' | 'playlist'; id: string } | null {
  const value = input.trim().replace(/^<|>$/g, '');
  const uri = value.match(/^spotify:(track|album|playlist):([A-Za-z0-9]{22})$/);
  if (uri) return { type: uri[1] as 'track' | 'album' | 'playlist', id: uri[2] };
  try { const url = new URL(value); if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com') return null; const match = url.pathname.match(/^\/(?:intl-[a-z]+\/)?(track|album|playlist)\/([A-Za-z0-9]{22})\/?$/); return match ? { type: match[1] as 'track' | 'album' | 'playlist', id: match[2] } : null; } catch { return null; }
}
export function toTrack(track: any, album?: any): Track { return { uri: track.uri, title: track.name, artist: (track.artists || []).map((a: any) => a.name).join(', '), album: track.album?.name || album?.name || '', image: track.album?.images?.[0]?.url || album?.images?.[0]?.url || '', durationMs: track.duration_ms || 0, url: track.external_urls?.spotify || `https://open.spotify.com/track/${track.id}` }; }
export class Spotify {
  config: Config; store: Store; refreshPromise: Promise<string> | null = null;
  constructor(config: Config, store: Store) { this.config = config; this.store = store; }
  get connected() { return !!this.store.get<string>('spotifyTokens'); }
  challenge(verifier: string) { return createHash('sha256').update(verifier).digest('base64url'); }
  async exchange(code: string, verifier: string) { return this.tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: this.config.origin + '/auth/spotify/callback', client_id: this.config.clientId }); }
  private async tokenRequest(body: Record<string, string>) {
    const response = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', body: new URLSearchParams(body), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new AppError('Login Spotify gagal. Periksa Client ID, callback URL, dan izin akun.', 502);
    const next = await response.json() as any;
    const previous = this.store.get<string>('spotifyTokens');
    const old = previous ? decrypt<Tokens>(previous, this.config.encryptionKey) : null;
    const tokens: Tokens = { access_token: next.access_token, refresh_token: next.refresh_token || old?.refresh_token || '', expiresAt: Date.now() + next.expires_in * 1000, scope: next.scope || old?.scope || '' };
    this.store.set('spotifyTokens', encrypt(tokens, this.config.encryptionKey)); return tokens.access_token;
  }
  async token() {
    const data = this.store.get<string>('spotifyTokens'); if (!data) throw new AppError('Hubungkan akun Spotify terlebih dahulu.', 409);
    const tokens = decrypt<Tokens>(data, this.config.encryptionKey);
    if (tokens.expiresAt > Date.now() + 60000) return tokens.access_token;
    if (!this.refreshPromise) this.refreshPromise = this.tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: this.config.clientId }).finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }
  async api(path: string, method = 'GET', body?: unknown, retried = false): Promise<any> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new AppError('Endpoint Spotify tidak valid.');
    const response = await fetch('https://api.spotify.com/v1' + path, { method, headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    if (response.status === 401 && method === 'GET' && !retried) { const value = this.store.get<string>('spotifyTokens'); if (value) { const t = decrypt<Tokens>(value, this.config.encryptionKey); t.expiresAt = 0; this.store.set('spotifyTokens', encrypt(t, this.config.encryptionKey)); } return this.api(path, method, body, true); }
    if (!response.ok) { if (response.status === 429) { const error = new AppError('Batas request Spotify tercapai. Tunggu sebentar sebelum mencoba lagi.', 429); const retry = Number(response.headers.get('retry-after')); error.retryAfterMs = Number.isFinite(retry) && retry > 0 ? retry * 1000 : 30000; throw error; } if (response.status === 404) throw new AppError('Spotify tidak menemukan perangkat/lagu. Aktifkan player browser ini lalu coba lagi.', 409); if (response.status === 403) throw new AppError('Spotify menolak akses. Pastikan akun Premium dan diizinkan di Developer Dashboard.', 403); throw new AppError(`Spotify sedang tidak tersedia (HTTP ${response.status}). Command tidak diulang otomatis.`, 502); }
    if (response.status === 204) return null;
    const text = await response.text();
    // Some playback commands return HTTP 200 with an empty body.
    if (!text.trim()) return null;
    try { return JSON.parse(text); }
    catch { throw new AppError('Respons Spotify tidak valid. Command tidak diulang otomatis.', 502); }
  }
  async search(query: string): Promise<Track[]> { const data = await this.api('/search?type=track&limit=8&q=' + encodeURIComponent(query)); return (data.tracks?.items || []).filter(Boolean).map((t: any) => toTrack(t)); }
  async resolve(input: string): Promise<Track[]> {
    let ref = spotifyReference(input);
    if (!ref && /\bplaylist\b/i.test(input) && !/^(https?:|spotify:)/i.test(input.trim())) { const query = input.replace(/\b(?:playlist|putar|play|lagu|paling|booming)\b/gi, ' ').trim(); if (!query) throw new AppError('Sebutkan nama/tema playlist atau URL playlist.'); const results = await this.api('/search?type=playlist&limit=5&q=' + encodeURIComponent(query)); const playlist = results.playlists?.items?.find((p: any) => p?.uri); if (!playlist) throw new AppError('Playlist tidak ditemukan.'); ref = spotifyReference(playlist.uri); }
    if (!ref) { if (/^(?:https?:|spotify:)/i.test(input.trim())) throw new AppError('Gunakan URL track, album, atau playlist dari open.spotify.com.'); const tracks = await this.search(input); if (!tracks.length) throw new AppError('Lagu tidak ditemukan. Coba judul dan nama artis.'); return [tracks[0]]; }
    if (ref.type === 'track') { const t = await this.api(`/tracks/${ref.id}`); if (t.is_playable === false || t.is_local) throw new AppError('Lagu tidak tersedia untuk akun ini.'); return [toTrack(t)]; }
    let container: any;
    try { container = await this.api(`/${ref.type}s/${ref.id}`); } catch (error) { if (ref.type === 'playlist' && error instanceof AppError) throw new AppError('Playlist tidak dapat dibaca melalui Spotify API. Antrean aplikasi memerlukan daftar track; tidak ada playback/antrean yang diubah. Gunakan URL track, album, atau playlist yang dapat diakses akun ini.', error.status); throw error; }
    const tracks: Track[] = []; let path: string | null = `/${ref.type}s/${ref.id}/${ref.type === 'playlist' ? 'items' : 'tracks'}?limit=50`;
    while (path && tracks.length < 200) {
      let page: any;
      try { page = await this.api(path); }
      catch (error) { if (ref.type === 'playlist' && error instanceof AppError && error.status === 403) throw new AppError('Metadata playlist tersedia, tetapi Spotify menolak akses daftar lagunya (HTTP 403). Playlist ini tidak dapat ditambahkan sebagai antrean track: ' + `https://open.spotify.com/playlist/${ref.id}` + '. Pada konsep antrean aplikasi, playlist harus bisa dibaca menjadi track. Gunakan URL track/album atau playlist yang dapat diakses akun ini.', 403); throw error; }
      for (const row of page.items || []) { const t = ref.type === 'playlist' ? row.item || row.track : row; if (t?.uri?.startsWith('spotify:track:') && !t.is_local && t.is_playable !== false) tracks.push(toTrack(t, ref.type === 'album' ? container : undefined)); }
      if (page.next) { const url = new URL(page.next); if (url.origin !== 'https://api.spotify.com' || !url.pathname.startsWith('/v1/')) throw new AppError('Pagination Spotify tidak valid.'); path = url.pathname.slice(3) + url.search; } else path = null;
    }
    if (path || tracks.length > 200) throw new AppError('Maksimal 200 track per request. Pilih album/playlist yang lebih kecil.');
    if (!tracks.length) throw new AppError('Tidak ada track yang tersedia dalam album/playlist ini.'); return tracks;
  }
}
