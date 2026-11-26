import type { Config } from './config.ts';
import { Store } from './database.ts';
import type { SongRequest } from './types.ts';
export class Notifications {
  store: Store; config: Config; busy = false;
  constructor(store: Store, config: Config) { this.store = store; this.config = config; }
  async dispatch() {
    if (this.busy || !this.config.wahaKey || !this.config.wahaUrl) return;
    this.busy = true;
    try {
      const row = this.store.db.prepare("SELECT id,data FROM outbox WHERE status='pending' ORDER BY created_at LIMIT 1").get() as { id: string; data: string } | undefined;
      if (!row) return;
      const request = JSON.parse(row.data) as SongRequest;
      if (request.groupId !== this.config.groupId || !/^[0-9]+@(?:c\.us|s\.whatsapp\.net|lid)$/.test(request.senderId)) { this.store.db.prepare("UPDATE outbox SET status='failed',error='Identitas pengirim/grup tidak valid.' WHERE id=?").run(row.id); return; }
      const claim = this.store.db.prepare("UPDATE outbox SET status='sending' WHERE id=? AND status='pending'").run(row.id);
      if (!claim.changes) return;
      try {
        const response = await fetch(this.config.wahaUrl.replace(/\/$/, '') + '/api/sendText', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': this.config.wahaKey }, body: JSON.stringify({ session: this.config.wahaSession, chatId: this.config.groupId, mentions: [request.senderId], reply_to: request.messageId, text: `@${request.senderId.split('@')[0]}, request kamu sekarang diputar:\n*${request.title} — ${request.artist}*\n${request.url}`, linkPreview: false }), signal: AbortSignal.timeout(8000) });
        const result = await response.json() as { id?: unknown };
        if (!response.ok || !result.id) throw new Error('WAHA tidak mengonfirmasi pesan.');
        this.store.db.prepare("UPDATE outbox SET status='sent' WHERE id=?").run(row.id);
      } catch { this.store.db.prepare("UPDATE outbox SET status='uncertain',error='Pengiriman gagal/tidak pasti; tidak diulang otomatis.' WHERE id=?").run(row.id); }
    } finally { this.busy = false; }
  }
}
