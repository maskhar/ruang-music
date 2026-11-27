import type { Config } from './config.ts';
import { Store } from './database.ts';
import type { SongRequest } from './types.ts';
import { randomUUID } from 'node:crypto';

interface SpotifyReadyNotice {
  type: 'spotify_ready';
  groupId: string;
  roomName: string;
  roomUrl: string;
}

export class Notifications {
  store: Store; config: Config; busy = false;
  constructor(store: Store, config: Config, private allowsGroup = (id: string) => config.groupIds.includes(id)) { this.store = store; this.config = config; }
  enqueueSpotifyReady(notice: Omit<SpotifyReadyNotice,'type'>) {
    if (!this.config.wahaKey || !this.config.wahaUrl || !this.allowsGroup(notice.groupId)) return;
    const id = randomUUID();
    this.store.db.prepare("INSERT INTO outbox(id,request_id,data,status,created_at) VALUES(?,?,?,'pending',?)")
      .run(id,'spotify-ready:' + id,JSON.stringify({type:'spotify_ready',...notice}),Date.now());
  }
  async dispatch() {
    if (this.busy || !this.config.wahaKey || !this.config.wahaUrl) return;
    this.busy = true;
    try {
      const row = this.store.db.prepare("SELECT id,data FROM outbox WHERE status='pending' ORDER BY created_at LIMIT 1").get() as { id: string; data: string } | undefined;
      if (!row) return;
      const notice = JSON.parse(row.data) as SongRequest | SpotifyReadyNotice;
      if (!this.allowsGroup(notice.groupId)) { this.store.db.prepare("UPDATE outbox SET status='failed',error='Grup sudah tidak terhubung ke ruang ini.' WHERE id=?").run(row.id); return; }
      let message: {text:string; mentions?:string[]; reply_to?:string};
      if ('type' in notice) {
        message = {text:`Spotify sudah terhubung ke ruang *${notice.roomName}*. Kirim /play judul lagu untuk membuat request. Aktifkan player di dashboard untuk memutar.\n\n${notice.roomUrl}`};
      } else {
        if (!/^[0-9]+@(?:c\.us|s\.whatsapp\.net|lid)$/.test(notice.senderId)) {
          this.store.db.prepare("UPDATE outbox SET status='failed',error='Identitas pengirim tidak valid.' WHERE id=?").run(row.id);
          return;
        }
        message = {mentions:[notice.senderId], reply_to:notice.messageId, text:`@${notice.senderId.split('@')[0]}, request kamu sekarang diputar:\n*${notice.title} — ${notice.artist}*\n${notice.url}`};
      }
      const claim = this.store.db.prepare("UPDATE outbox SET status='sending' WHERE id=? AND status='pending'").run(row.id);
      if (!claim.changes) return;
      try {
        const response = await fetch(this.config.wahaUrl.replace(/\/$/, '') + '/api/sendText', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': this.config.wahaKey }, body: JSON.stringify({ session: this.config.wahaSession, chatId:notice.groupId,...message,linkPreview:false }), signal: AbortSignal.timeout(8000) });
        const result = await response.json() as { id?: unknown };
        if (!response.ok || !result.id) throw new Error('WAHA tidak mengonfirmasi pesan.');
        this.store.db.prepare("UPDATE outbox SET status='sent' WHERE id=?").run(row.id);
      } catch { this.store.db.prepare("UPDATE outbox SET status='uncertain',error='Pengiriman gagal/tidak pasti; tidak diulang otomatis.' WHERE id=?").run(row.id); }
    } finally { this.busy = false; }
  }
}
