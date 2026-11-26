import type { PublicRequest, Snapshot, Track } from '../server/types';

type DisplayRequest = PublicRequest & { external?: boolean };
const externalRequest = (track: Track, index: number): DisplayRequest => ({ ...track, id: `spotify-${index}-${track.uri}`, requester: 'Spotify', source: 'web', status: 'queued', createdAt: 0, startedAt: null, positionMs: 0, error: '', external: true });

export function playbackView(state: Snapshot | null) {
  const native = state?.spotifyPlayback;
  const appQueue = state?.queue || [];
  const connected = !!state?.playback.connected;
  const managed = state?.current && (connected || native?.current?.uri === state.current.uri) ? state.current : null;
  const externalCurrent = !managed && native?.current ? externalRequest(native.current, -1) : null;
  const current = managed || externalCurrent;
  const nativeQueue = !managed || !connected ? (native?.queue || []).map(externalRequest) : [];
  const synced = new Set(state?.syncedRequestIds || []);
  const waitingRequests = connected ? [] : appQueue.filter(r => !synced.has(r.id));
  const queue: DisplayRequest[] = [...nativeQueue, ...(connected ? appQueue : [])];
  const useNativeProgress = current && native?.current?.uri === current.uri && (!connected || !!externalCurrent);
  const playback = state?.playback && useNativeProgress && native ? { ...state.playback, paused: native.paused, positionMs: native.positionMs, durationMs: native.durationMs, updatedAt: native.observedAt } : state?.playback;
  const hasPlayback = !!current && (connected || !!native?.deviceId);
  return { native, appQueue, externalCurrent, current, nativeQueue, waitingRequests, queue, playback, hasPlayback };
}
