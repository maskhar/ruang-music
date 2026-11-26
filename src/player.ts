import { api } from './api';
declare global { interface Window { Spotify?: any; onSpotifyWebPlaybackSDKReady?: () => void; } }
let sdkPromise: Promise<void> | null = null;
function loadSDK() {
  if (window.Spotify) return Promise.resolve();
  if (!sdkPromise) sdkPromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { sdkPromise = null; reject(new Error('SDK Spotify belum termuat. Periksa koneksi atau pemblokir browser.')); }, 20000);
    window.onSpotifyWebPlaybackSDKReady = () => { clearTimeout(timeout); resolve(); };
    const script = document.createElement('script'); script.src = 'https://sdk.scdn.co/spotify-player.js'; script.async = true; script.onerror = () => { clearTimeout(timeout); sdkPromise = null; reject(new Error('SDK Spotify gagal dimuat.')); }; document.head.append(script);
  }); return sdkPromise;
}
export class BrowserPlayer {
  instance: any = null; timer: ReturnType<typeof setInterval> | null = null; deviceId = ''; claimed = false;
  socket: () => WebSocket | null; connection: () => string; onError: (message: string) => void;
  constructor(socket: () => WebSocket | null, connection: () => string, onError: (message: string) => void) { this.socket = socket; this.connection = connection; this.onError = onError; }
  send(data: unknown) { const socket = this.socket(); if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); }
  async activate(takeover = false) {
    if (!window.isSecureContext) throw new Error('Player memerlukan HTTPS. Buka https://spotify.carubra.com.');
    await loadSDK();
    if (!this.connection()) throw new Error('Koneksi realtime belum siap. Tunggu sebentar.');
    if (!this.instance) {
      this.instance = new window.Spotify.Player({ name: 'Ruang Musik · Carubra', volume: 0.7, getOAuthToken: (callback: (token: string) => void) => { void api('/api/spotify/token').then(data => callback(data.accessToken)).catch(error => this.onError(error.message)); } });
      for (const event of ['initialization_error', 'authentication_error', 'account_error', 'playback_error']) this.instance.addListener(event, ({ message }: { message: string }) => { this.onError(message); this.send({ type: 'player_error', message }); });
      this.instance.addListener('autoplay_failed', () => { const message = 'Browser meminta sentuhan. Tekan Aktifkan audio, lalu Putar.'; this.onError(message); this.send({ type: 'player_error', message, needsGesture: true }); });
      this.instance.addListener('not_ready', () => { this.claimed = false; this.onError('Player Spotify terputus. Aktifkan kembali.'); });
      this.instance.addListener('player_state_changed', (state: any) => this.telemetry(state));
      const ready = new Promise<string>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Perangkat browser belum siap. Periksa Premium, DRM, dan izin akun Spotify.')), 20000); this.instance.addListener('ready', ({ device_id }: { device_id: string }) => { clearTimeout(timer); this.deviceId = device_id; resolve(device_id); }); });
      // Call on the user's click; subsequent reactivation also calls this directly.
      this.instance.activateElement();
      const connected = await this.instance.connect(); if (!connected) throw new Error('Browser tidak dapat terhubung ke Spotify.'); await ready;
    } else this.instance.activateElement();
    await api('/api/player/claim', 'POST', { connectionId: this.connection(), deviceId: this.deviceId, takeover }); this.claimed = true;
    if (this.timer) clearInterval(this.timer); this.timer = setInterval(() => { void this.instance.getCurrentState().then((s: any) => this.telemetry(s)); }, 3000);
    const state = await this.instance.getCurrentState(); this.telemetry(state);
  }
  telemetry(state: any) { if (!this.claimed || !state) return; this.send({ type: 'telemetry', data: { uri: state.track_window?.current_track?.uri || '', paused: !!state.paused, positionMs: state.position || 0, durationMs: state.duration || 0 } }); }
  async volume(volume: number) { try { if (!this.instance || !this.claimed) throw new Error('Player tidak aktif.'); await this.instance.setVolume(volume / 100); const actual = await this.instance.getVolume(); if (Math.abs(actual - volume / 100) > 0.08) throw new Error('Kontrol volume tidak didukung browser ini.'); this.send({ type: 'volume_result', ok: true }); } catch { this.send({ type: 'volume_result', ok: false }); this.onError('Browser menolak volume. Gunakan tombol volume Android.'); } }
  async wakeAudio() { if (this.instance) this.instance.activateElement(); }
  async release() { if (this.claimed && this.connection()) await api('/api/player/release', 'POST', { connectionId: this.connection() }); this.disconnect(); }
  disconnect() { this.claimed = false; if (this.timer) clearInterval(this.timer); this.timer = null; this.instance?.disconnect(); this.instance = null; }
}
