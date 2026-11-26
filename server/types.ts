export type Status = 'queued' | 'starting' | 'playing' | 'completed' | 'skipped' | 'cancelled' | 'failed';
export interface Track { uri: string; title: string; artist: string; album: string; image: string; durationMs: number; url: string; }
export interface SongRequest extends Track { id: string; requester: string; source: 'web' | 'whatsapp'; senderId: string; messageId: string; groupId: string; status: Status; createdAt: number; startedAt: number | null; positionMs: number; error: string; }
export interface Telemetry { uri: string; paused: boolean; positionMs: number; durationMs: number; }
export interface PublicRequest extends Omit<SongRequest, 'senderId' | 'messageId' | 'groupId'> {}
export interface Playback { connected: boolean; deviceName: string; paused: boolean; positionMs: number; durationMs: number; updatedAt: number; volume: number; error: string; needsGesture: boolean; }
export interface SpotifyPlayback { current: Track | null; queue: Track[]; observedAt: number; paused: boolean; positionMs: number; durationMs: number; deviceId: string; deviceName: string; volume: number; syncError: string; filteredCount: number; }
export interface Snapshot { current: PublicRequest | null; queue: PublicRequest[]; history: PublicRequest[]; playback: Playback; spotifyPlayback: SpotifyPlayback; notificationsFailed: number; spotifyConnected: boolean; spotifyConfigured: boolean; whatsappConfigured: boolean; callbackUrl: string; origin: string; }
export class AppError extends Error { status: number; retryAfterMs?: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
