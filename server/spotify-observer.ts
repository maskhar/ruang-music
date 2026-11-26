import { EventEmitter } from 'node:events';
import { AppError, type SpotifyPlayback, type Track } from './types.ts';
import { Spotify, toTrack } from './spotify.ts';
import type { Store } from './database.ts';

// Spotify sometimes appends many copies of the playing/previous track. Keep
// genuine repeated requests elsewhere; only suppress a recognized repeated tail.
export function filterSpotifyTail(queue: Track[], currentUri: string, previousGhosts: string[] = []) {
  const tail = queue.at(-1)?.uri || '';
  let first = queue.length;
  while (first > 0 && queue[first - 1].uri === tail) first--;
  const ghost = tail && queue.length - first >= 3 && (tail === currentUri || previousGhosts.includes(tail)) ? tail : '';
  return { tracks: ghost ? queue.slice(0, first) : queue, ghost, filteredCount: ghost ? queue.length - first : 0 };
}

export class SpotifyObserver extends EventEmitter {
  state: SpotifyPlayback = { current: null, queue: [], observedAt: 0, paused: true, positionMs: 0, durationMs: 0, deviceId: '', deviceName: '', volume: 70, syncError: '', filteredCount: 0 };
  private pending: Promise<void> | null = null;
  private retryAt = 0;
  private ghosts: Record<string, number>;
  private stopped = false;
  constructor(private spotify: Pick<Spotify, 'api' | 'connected'>, private store?: Pick<Store, 'get' | 'set'>) { super(); this.ghosts = store?.get<Record<string, number>>('spotifyQueueGhosts') || {}; }

  refresh(force = false): Promise<void> {
    if (this.stopped || !this.spotify.connected || Date.now() < this.retryAt) return Promise.resolve();
    if (this.pending) return this.pending;
    if (!force && Date.now() - this.state.observedAt < 4000) return Promise.resolve();
    this.pending = this.poll().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async poll() {
    // Wait for both reads even on failure; never overlap polling generations.
    const results = await Promise.allSettled([this.spotify.api('/me/player'), this.spotify.api('/me/player/queue')]);
    if (this.stopped) return;
    const failed = results.find(r => r.status === 'rejected');
    if (failed?.status === 'rejected') {
      const error = failed.reason;
      this.retryAt = Date.now() + (error instanceof AppError && error.status === 429 ? Math.max(10000, error.retryAfterMs || 30000) : 10000);
      this.state = { ...this.state, syncError: error instanceof Error ? error.message : 'Sinkronisasi Spotify tertunda.' };
      this.emit('change'); return;
    }
    const player = (results[0] as PromiseFulfilledResult<any>).value;
    const data = (results[1] as PromiseFulfilledResult<any>).value;
    if (player?.item?.uri && data?.currently_playing?.uri && player.item.uri !== data.currently_playing.uri) {
      this.state = { ...this.state, syncError: 'Spotify sedang berganti lagu. Menunggu pembaruan berikutnya.' };
      this.emit('change'); return;
    }
    // A stale queue response without an active player is not upcoming playback.
    const item = player?.device && player?.item?.uri?.startsWith('spotify:track:') ? player.item : null;
    const tracks = item && Array.isArray(data?.queue) ? data.queue.filter((t: any) => t?.uri?.startsWith('spotify:track:')).map((t: any) => toTrack(t)) : [];
    this.ghosts = Object.fromEntries(Object.entries(this.ghosts).filter(([, at]) => Date.now() - at < 86400000));
    const filtered = filterSpotifyTail(tracks, item?.uri || '', Object.keys(this.ghosts));
    if (filtered.ghost) this.ghosts[filtered.ghost] = Date.now();
    this.store?.set('spotifyQueueGhosts', this.ghosts);
    this.state = { current: item ? toTrack(item) : null, queue: filtered.tracks, observedAt: Date.now(), paused: player?.is_playing !== true, positionMs: player?.progress_ms || 0, durationMs: item?.duration_ms || 0, deviceId: player?.device?.id || '', deviceName: player?.device?.name || '', volume: player?.device?.volume_percent ?? 70, syncError: '', filteredCount: filtered.filteredCount };
    this.emit('change');
  }

  stop() { this.stopped = true; this.removeAllListeners(); }
}
