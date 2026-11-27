import { EventEmitter } from 'node:events';
import { AppError, type SpotifyPlayback } from './types.ts';
import { Spotify, toTrack } from './spotify.ts';

export class SpotifyObserver extends EventEmitter {
  state: SpotifyPlayback = { current: null, queue: [], observedAt: 0, paused: true, positionMs: 0, durationMs: 0, deviceId: '', deviceName: '', volume: 70, syncError: '', filteredCount: 0 };
  private pending: Promise<void> | null = null;
  private retryAt = 0;
  private stopped = false;
  constructor(private spotify: Pick<Spotify, 'api' | 'connected'>) { super(); }

  refresh(force = false): Promise<void> {
    if (this.stopped || !this.spotify.connected || Date.now() < this.retryAt) return Promise.resolve();
    if (this.pending) return this.pending;
    if (!force && Date.now() - this.state.observedAt < 15000) return Promise.resolve();
    this.pending = this.poll().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async poll() {
    // Wait for both reads even on failure; never overlap polling generations.
    const results = await Promise.allSettled([this.spotify.api('/me/player')]);
    if (this.stopped) return;
    const failed = results.find(r => r.status === 'rejected');
    if (failed?.status === 'rejected') {
      const error = failed.reason;
      this.retryAt = Date.now() + (error instanceof AppError && error.status === 429 ? Math.max(10000, error.retryAfterMs || 30000) : 10000);
      this.state = { ...this.state, syncError: error instanceof Error ? error.message : 'Sinkronisasi Spotify tertunda.' };
      this.emit('change'); return;
    }
    const player = (results[0] as PromiseFulfilledResult<any>).value;
    const item = player?.device && player?.item?.uri?.startsWith('spotify:track:') ? player.item : null;
    this.state = { current: item ? toTrack(item) : null, queue: [], observedAt: Date.now(), paused: player?.is_playing !== true, positionMs: player?.progress_ms || 0, durationMs: item?.duration_ms || 0, deviceId: player?.device?.id || '', deviceName: player?.device?.name || '', volume: player?.device?.volume_percent ?? 70, syncError: '', filteredCount: 0 };
    this.emit('change');
  }

  stop() { this.stopped = true; this.removeAllListeners(); }
}
