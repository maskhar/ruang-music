import { EventEmitter } from 'node:events';
import { Store } from './database.ts';
import { Spotify } from './spotify.ts';
import { AppError, type Playback, type SongRequest, type Telemetry, type Track } from './types.ts';
export interface PlayerLease { connectionId: string; deviceId: string; updatedAt: number; }
export class Queue extends EventEmitter {
  store: Store; spotify: Pick<Spotify, 'api' | 'connected'>; lease: PlayerLease | null = null;
  playback: Playback = { connected: false, deviceName: 'Belum ada player', paused: true, positionMs: 0, durationMs: 0, updatedAt: 0, volume: 70, error: '', needsGesture: false };
  serial: Promise<unknown> = Promise.resolve(); armed = false; startedAt = 0; lastState: Telemetry | null = null;
  constructor(store: Store, spotify: Pick<Spotify, 'api' | 'connected'>) { super(); this.store = store; this.spotify = spotify; }
  run<T>(fn: () => Promise<T>): Promise<T> { const promise = this.serial.then(fn); this.serial = promise.catch(() => {}); return promise; }
  changed() { this.emit('change'); }
  current() { return this.store.active(); }
  device() { if (!this.lease || Date.now() - this.lease.updatedAt > 30000) throw new AppError('Player browser belum aktif. Tekan Aktifkan player pada perangkat yang mengeluarkan suara.', 409); return encodeURIComponent(this.lease.deviceId); }
  async claim(connectionId: string, deviceId: string, takeover = false) {
    return this.run(async () => { if (this.lease && this.lease.connectionId !== connectionId && Date.now() - this.lease.updatedAt < 30000 && !takeover) throw new AppError('Player lain masih aktif. Lepaskan player tersebut atau gunakan Ambil alih.', 409);
      await this.spotify.api('/me/player', 'PUT', { device_ids: [deviceId], play: false });
      this.lease = { connectionId, deviceId, updatedAt: Date.now() }; this.armed = false; this.lastState = null;
      this.playback = { ...this.playback, connected: true, deviceName: 'Player browser', paused: true, error: '', needsGesture: false, updatedAt: Date.now() }; this.changed();
    });
  }
  release(connectionId: string) { if (this.lease?.connectionId === connectionId) { this.lease = null; this.armed = false; this.playback.connected = false; this.playback.paused = true; this.playback.deviceName = 'Player terputus'; this.changed(); } }
  async enqueue(tracks: Track[], person: Parameters<Store['add']>[1]) {
    return this.run(async () => { if (this.store.list('queued', 1000).length + tracks.length > 500) throw new AppError('Antrean penuh (maksimal 500 request).'); const added = this.store.add(tracks, person); this.changed(); if (!this.current() && this.lease && Date.now() - this.lease.updatedAt <= 30000) await this.startNext(); return added; });
  }
  async startNext() {
    if (this.current()) return;
    const next = this.store.list('queued', 1)[0];
    if (!next) { this.playback.paused = true; this.playback.positionMs = 0; this.playback.durationMs = 0; this.changed(); return; }
    const device = this.device(); next.status = 'starting'; this.store.save(next); this.store.set('activeRequest', next.id); this.armed = false; this.lastState = null; this.startedAt = Date.now(); this.playback.error = ''; this.playback.needsGesture = false;
    try { await this.spotify.api('/me/player/play?device_id=' + device, 'PUT', { uris: [next.uri] }); }
    catch (error) { next.status = 'failed'; next.error = error instanceof Error ? error.message : 'Playback gagal.'; this.store.save(next); this.store.set('activeRequest', null); this.playback.error = next.error; }
    this.changed();
  }
  async resume() { return this.run(async () => { const device = this.device(); const current = this.current(); this.playback.error = ''; this.playback.needsGesture = false;
    if (!current) { if (this.store.list('queued', 1).length) await this.startNext(); else await this.spotify.api('/me/player/play?device_id=' + device, 'PUT', {}); return; }
    if (this.lastState?.uri === current.uri && this.armed) await this.spotify.api('/me/player/play?device_id=' + device, 'PUT', {});
    else { this.startedAt = Date.now(); this.armed = false; current.status = 'starting'; this.store.save(current); await this.spotify.api('/me/player/play?device_id=' + device, 'PUT', { uris: [current.uri], position_ms: Math.min(current.positionMs, Math.max(0, current.durationMs - 1000)) }); }
    this.changed();
  }); }
  async pause() { return this.run(async () => { await this.spotify.api('/me/player/pause?device_id=' + this.device(), 'PUT'); this.playback.paused = true; this.changed(); }); }
  async next() { return this.run(async () => { const device = this.device(); const current = this.current(); if (!current && !this.store.list('queued', 1).length) { await this.spotify.api('/me/player/next?device_id=' + device, 'POST'); return; } await this.spotify.api('/me/player/pause?device_id=' + device, 'PUT'); if (current) { current.status = 'skipped'; this.store.save(current); } this.store.set('activeRequest', null); this.armed = false; await this.startNext(); }); }
  clear() { return this.run(async () => { const count = this.store.cancelQueued(); this.changed(); return count; }); }
  remove(id: string) { return this.run(async () => { const request = this.store.request(id); if (!request || request.status !== 'queued') throw new AppError('Request sudah diputar atau tidak ditemukan.', 409); request.status = 'cancelled'; this.store.save(request); this.changed(); }); }
  async telemetry(connectionId: string, state: Telemetry) {
    return this.run(async () => { if (this.lease?.connectionId !== connectionId) return; this.lease.updatedAt = Date.now();
      const current = this.current(), previous = this.lastState;
      const elapsed = Math.max(0, (Date.now() - this.playback.updatedAt));
      const previousEstimated = previous ? previous.positionMs + (previous.paused ? 0 : elapsed) : 0;
      const nearEnd = previous && previous.durationMs > 0 && previous.durationMs - previousEstimated <= 2500;
      const rolledBack = previous && state.positionMs + 5000 < previous.positionMs;
      const ended = !!(current && this.armed && previous && nearEnd && (state.uri !== current.uri || rolledBack || (state.paused && (state.positionMs < 1000 || (state.durationMs > 0 && state.positionMs >= state.durationMs)))));
      this.lastState = state; this.playback = { ...this.playback, paused: state.paused, positionMs: state.positionMs, durationMs: state.durationMs, updatedAt: Date.now() };
      if (ended && current) {
        current.status = 'completed'; current.positionMs = current.durationMs; this.store.save(current); this.store.set('activeRequest', null); this.armed = false;
        // Stop Spotify's own continuation; our DB owns the next request.
        await this.spotify.api('/me/player/pause?device_id=' + this.device(), 'PUT'); await this.startNext(); return;
      }
      if (current && state.uri === current.uri) {
        current.positionMs = state.positionMs;
        if (!state.paused) { this.armed = true; this.playback.error = ''; this.playback.needsGesture = false; this.store.confirmStarted(current); }
        else this.store.save(current);
      } else if (current && this.armed && state.uri && state.uri !== current.uri) {
        this.playback.error = 'Playback diubah dari luar antrean aplikasi. Tekan Putar untuk memulihkan request aktif.'; this.armed = false;
      }
      this.changed();
    });
  }
  error(connectionId: string, message: string, needsGesture = false) { if (this.lease?.connectionId === connectionId || !this.lease) { this.playback.error = message.slice(0, 250); this.playback.needsGesture = needsGesture; this.changed(); } }
  tick() { if (this.lease && Date.now() - this.lease.updatedAt > 30000) this.release(this.lease.connectionId); const active = this.current(); if (active?.status === 'starting' && this.startedAt && Date.now() - this.startedAt > 25000 && !this.armed && !this.playback.error) { this.playback.error = 'Browser belum mengonfirmasi audio. Tekan Aktifkan audio lalu Putar; request belum dianggap diputar.'; this.playback.needsGesture = true; this.changed(); } }
}
