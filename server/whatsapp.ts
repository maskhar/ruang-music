import type { Queue } from './queue.ts';
import type { Spotify } from './spotify.ts';
import type { Store } from './database.ts';
import { AppError } from './types.ts';

export async function whatsappCommand(text: string, person: Parameters<Store['add']>[1], deps: {
  queue: Queue; spotify: Spotify; store: Store; roomName: string; roomUrl: string; volume: (value: number) => void;
}) {
  const { queue, spotify, store } = deps;
  const match = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  const command = match?.[1]?.toLowerCase() || 'help';
  const arg = (match?.[2]?.trim() || '').replace(/^<(.+)>$/, '$1').replace(/^\[[^\]]*\]\((https:\/\/open\.spotify\.com\/[^)]+)\)$/, '$1');
  if ((['play', 'playlist', 'queue', 'antri'].includes(command) && arg && !(['queue', 'antri'].includes(command) && /^(list|next|lihat|cek)$/i.test(arg)))) {
    const tracks = await spotify.resolve(command === 'playlist' && !/^(https:|spotify:)/i.test(arg) ? 'playlist ' + arg : arg);
    const added = await queue.enqueue(tracks, person);
    return `${added.length} request diterima di antrean aplikasi.\n${tracks[0].title} — ${tracks[0].artist}\n${tracks[0].url}\n${queue.playback.connected ? 'Lagu dikirim satu per satu sesuai giliran.' : 'Menunggu browser player diaktifkan.'} Kamu akan di-mention saat request mulai diputar.`;
  }
  if (['queue', 'antrean', 'antrian', 'queues'].includes(command)) {
    const rows = store.list('queued', 10), active = queue.current();
    return `*Antrean — ${deps.roomName}*\n` + (active ? `${active.status === 'starting' ? 'Menyiapkan' : queue.playback.paused ? 'Dijeda' : 'Sedang diputar'}: ${active.title} — ${active.artist}\n\n` : '') + (rows.length ? rows.map((r, i) => `${i + 1}. ${r.title} — ${r.artist} (${r.requester})`).join('\n') : 'Tidak ada request menunggu.') + '\n\nAntrean aplikasi; Spotify hanya menerima lagu saat mendapat giliran.';
  }
  if (['clearqueue', 'clear', 'kosongkan'].includes(command)) return `${await queue.clear()} request menunggu dibatalkan. Lagu aktif tidak dihentikan.`;
  if (command === 'stop') return `Playback dihentikan; ${await queue.stop()} request menunggu dibatalkan.`;
  if (command === 'pause') { await queue.pause(); return 'Playback dijeda; request menunggu tetap tersimpan.'; }
  if (['next', 'skip'].includes(command)) { await queue.next(); return queue.current() ? `Menyiapkan: ${queue.current()!.title} — ${queue.current()!.artist}` : 'Tidak ada request berikutnya. Playback dihentikan.'; }
  if (['resume', 'play'].includes(command) && !arg) {
    if (!queue.current() && !store.list('queued', 1).length) return 'Antrean aplikasi kosong. Tambahkan lagu dengan /play judul artis.';
    await queue.resume(); return 'Permintaan putar diterima player. Notifikasi dikirim setelah playback terkonfirmasi.';
  }
  if (['vol', 'volume'].includes(command)) { if (!/^\d{1,3}$/.test(arg) || Number(arg) > 100) throw new AppError('Volume harus 0–100. Contoh: /vol 10'); deps.volume(Number(arg)); return `Permintaan volume ${Number(arg)}% dikirim ke browser player. Dukungan volume bergantung perangkat.`; }
  if (['now', 'np', 'status'].includes(command)) { const active = queue.current(); return active ? `${active.status === 'starting' ? 'Menyiapkan' : queue.playback.paused ? 'Dijeda' : 'Sedang diputar'}: *${active.title} — ${active.artist}*\nRequest: ${active.requester}\n${active.url}` : 'Belum ada request aplikasi yang diputar.'; }
  if (['cari', 'search'].includes(command)) { if (!arg) throw new AppError('Contoh: /cari judul artis'); const tracks = await spotify.search(arg); return tracks.length ? tracks.map((t, i) => `${i + 1}. ${t.title} — ${t.artist}\n${t.url}`).join('\n\n') : 'Lagu tidak ditemukan.'; }
  if (['recent', 'riwayat'].includes(command)) { const rows = store.list(undefined, 10); return rows.length ? '*Riwayat request*\n' + rows.map((r, i) => `${i + 1}. ${r.title} — ${r.artist} (${r.status})`).join('\n') : 'Belum ada riwayat request.'; }
  return `*Ruang Musik — ${deps.roomName}*\n` + '/play judul artis atau URL track/album/playlist — masuk antrean aplikasi\n/playlist URL — masukkan track playlist ke antrean, tidak langsung mengganti lagu\n/queue — request menunggu\n/clearqueue — hapus semua request menunggu\n/now | /cari judul artis | /recent\n/pause | /resume | /next\n/stop — hentikan dan kosongkan request menunggu\n/vol 0–100 — volume browser\n\nAktifkan satu browser sebagai player: ' + deps.roomUrl;
}
