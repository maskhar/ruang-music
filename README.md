# Ruang Musik · Carubra

Player Spotify berbasis browser/PWA untuk ruang internal. Audio langsung dari Spotify Web Playback SDK ke browser player. Server tidak mengunduh, menyimpan, atau membagikan ulang audio.

Source: `I:\website-devops\spotify-player`. Domain: `https://spotify.carubra.com`.

## Status pemasangan

Docker service `spotify-player` tersedia pada `127.0.0.1:3210`, tergabung `carubra-network`. Client ID dari aplikasi Spotify yang dipakai n8n dan kredensial WAHA sudah diisi secara lokal. `.env` menyimpan password operator, kunci enkripsi, dan integration token; file ini diabaikan Git. Jangan membagikan file tersebut.

Domain dan login Spotify dapat dipakai sesuai konfigurasi aktif. Workflow n8n lama masih mengisi antrean Spotify; dashboard kini menyinkronkan playback dan antrean tersebut tanpa cutover. Adapter antrean aplikasi tetap tersedia pada `integration/n8n-waha-adapter.json`.

## Mengaktifkan domain dan Spotify

1. Di Cloudflare Zero Trust, buka tunnel yang digunakan container `network-carubra`. Tambahkan published application/public hostname `spotify.carubra.com`, service type **HTTP**, URL **spotify-player:3210**. DNS untuk hostname harus dibuat melalui tunnel tersebut. Aktifkan WebSocket bila ada pengaturan proxy tambahan. Jangan memilih `localhost:3210` karena tunnel berjalan dalam container.
2. Di Spotify Developer Dashboard untuk Client ID pada `.env`, tambahkan redirect URI persis `https://spotify.carubra.com/auth/spotify/callback`, lalu simpan. Aktifkan penggunaan Web Playback SDK/Web API bila diminta. Akun pengguna harus diizinkan oleh aplikasi Spotify, sesuai batas development mode Spotify.
3. Buka domain tersebut. Masuk menggunakan `ADMIN_PASSWORD` pada `.env`. Tekan **Hubungkan Spotify**, lalu login melalui halaman resmi Spotify memakai akun Premium yang sama dengan akun pemutaran kantor.
4. Di Chrome Android yang mendukung DRM/Widevine, tekan **Aktifkan player di browser ini**. Tambahkan satu request, lalu tekan **Putar**. Browser mungkin meminta sentuhan tambahan melalui **Aktifkan audio kembali**.
5. Verifikasi audio benar-benar keluar dari perangkat tersebut sebelum mengalihkan WhatsApp. Dashboard lain bisa mengontrol antrean, tetapi hanya satu browser memiliki output aktif. Ambil alih meminta konfirmasi.

Spotify Premium diperlukan; paket mobile-only tertentu tidak mendukung SDK. Dukungan browser, DRM, aturan Spotify, dan izin akun tetap berlaku. Pemakaian komersial SDK memerlukan izin Spotify. Biarkan player di depan; layar mati/background Android dapat menghentikan browser. PWA bisa dipasang melalui menu Chrome. Kontrol volume SDK tidak dijamin pada Android: gunakan tombol perangkat bila browser menolak.

## Fitur dan antrean

- Request judul/artis, URL atau URI Spotify track, album, playlist. Pencarian teks mengambil track pertama berdasarkan relevansi Spotify; tidak mengklaim lagu/playlist paling populer. Pilihan hasil pencarian tersedia di web.
- Maksimal 200 track per album/playlist; 500 request menunggu. Album mengikuti urutan Spotify. Lagu sama boleh diminta lebih dari sekali dan disimpan sebagai request terpisah.
- Dashboard membaca lagu aktif beserta antrean Spotify setiap 5 detik selama operator terhubung, lalu mengirim snapshot lewat WebSocket. Nama, artis, cover, posisi, dan perubahan antrean ikut diperbarui tanpa reload. Request WhatsApp workflow lama terlihat sebagai **Antrean Spotify**; identitas peminta tidak ditebak.
- Antrean aplikasi tersimpan dalam SQLite, terpisah dari antrean bawaan Spotify. Lagu terakhir dibersihkan setelah SDK melaporkan akhir; Spotify continuation dihentikan. Lagu dari playlist/autoplay Spotify tidak dimasukkan sebagai request palsu.
- Antrean native dan request aplikasi diberi sumber berbeda. Hapus/kosongkan hanya berlaku untuk request aplikasi, karena Spotify Web API tidak menyediakan hapus/clear antrean native. Ekor seragam minimal 3 salinan lagu aktif atau lagu yang telah dikenali sebagai duplikat usang disaring secara heuristik; daftar pengenal ini disimpan hingga 24 jam dan bertahan setelah restart. Spotify tidak menyediakan ID kejadian antrean, sehingga pengulangan native tidak dapat dibedakan sempurna; request berulang dalam antrean aplikasi tetap utuh.
- Jeda, lanjut, berikutnya, volume, hapus satu request, kosongkan seluruh request menunggu dengan konfirmasi. Lagu aktif tetap berjalan saat antrean dikosongkan.
- Saat player terputus dan Spotify tidak memutar request aktif, lagu lama tidak ditampilkan sebagai Now Playing. Setelah pembacaan Spotify yang berhasil berulang selama 15 detik (dan masa mulai minimal 30 detik), request aktif yang tidak lagi terdeteksi dipindahkan ke riwayat dengan status **Terhenti**. Gangguan API, jeda pada lagu yang sama, dan reconnect singkat tidak dianggap selesai. Request belum diputar tetap tersimpan dalam bagian **Request tersimpan**, terpisah dari jumlah antrean pemutaran, sampai player diaktifkan.
- Riwayat 20 request terakhir. Browser terputus tidak menghapus antrean; aktifkan browser lalu lanjutkan. Posisi terakhir disimpan, tetapi kelanjutan audio tidak dijamin tanpa browser aktif.
- Notifikasi WAHA di grup, mention pengirim dan balas pesan asal, setelah SDK melaporkan URI request sedang diputar. Ini konfirmasi state playback, bukan pengukuran speaker. Setiap request memiliki satu outbox notifikasi. Pengiriman ambigu tidak dicoba ulang otomatis agar tidak menggandakan pesan.
- Password operator server-side; session HttpOnly, SameSite, Secure pada HTTPS. Token refresh Spotify dienkripsi AES-256-GCM. WebSocket memakai session dan origin. Dashboard tidak menerima ID WhatsApp privat.

## Integrasi WhatsApp melalui n8n

Grup yang diizinkan: `120363430180897172@g.us`. Session: `carubra`. Credential WAHA: `WAHA account`.

Adapter belum aktif. Jangan jalankan adapter dan workflow lama untuk event yang sama. Urutan cutover:

1. Export dan simpan backup workflow utama `mMKGZXtIS2uvso8W` serta monitor `WJhwejxEcPWJpG6o`. Catat webhook WAHA lama dan konfigurasi event/session. Backup tidak cukup jika hanya disimpan dalam container.
2. Import `integration/n8n-waha-adapter.json` sebagai workflow nonaktif. Pada node **Request Ruang Musik**, pilih credential **Header Auth** baru: Name `Authorization`, Value `Bearer <INTEGRATION_TOKEN dari .env>`. Jangan menulis token langsung dalam JSON workflow. Node WAHA menggunakan credential `WAHA account`.
3. Pastikan n8n dan player tergabung `carubra-network`, atau sesuaikan URL internal node HTTP. Server menerima event yang telah dinormalisasi oleh adapter: session carubra, pesan grup target, bukan fromMe, participant valid. Adapter mengabaikan DM dan event lain.
4. Setelah login dan playback web berhasil, nonaktifkan workflow utama lama dan monitor lama. Aktifkan adapter dan arahkan webhook session WAHA `carubra` ke production webhook WAHA Trigger adapter. Catat konfigurasi lama untuk rollback. Langkah ini sengaja belum dilakukan pada pemasangan awal.
5. Uji dari anggota grup: `/play judul artis`, `/queue`, tunggu giliran dimulai, verifikasi mention hanya sekali, lalu `/clearqueue`. Uji pesan DM tidak diproses. Jika gagal, nonaktifkan adapter, pulihkan webhook WAHA lama, lalu aktifkan kembali kedua workflow lama.

Command adapter:

| Command | Hasil |
|---|---|
| `/play judul artis` atau URL/URI Spotify | Request baru, otomatis mulai bila player aktif dan tidak ada request aktif |
| `/play` atau `/resume` | Lanjutkan request aktif / mulai request menunggu |
| `/queue` atau `/antrean` | Maksimal 10 request menunggu beserta peminta |
| `/clearqueue` | Batalkan semua request menunggu; lagu aktif tetap berjalan |
| `/pause` | Jeda, antrean tetap tersimpan |
| `/stop` | Jeda dan batalkan semua request menunggu; lagu aktif dapat dilanjutkan |
| `/next` | Lewati request aktif, mulai berikutnya |
| `/help` | Panduan command |

`/queue judul artis` dari workflow lama tidak dipakai sebagai penambahan pada adapter ini; gunakan `/play judul artis`. Volume tersedia lewat dashboard web. Command lama `/prev`, `/recent`, dan AI bebas tidak diteruskan oleh adapter.

Endpoint integrasi `POST /api/integrations/whatsapp`, Header `Authorization: Bearer <INTEGRATION_TOKEN>`, JSON:

```json
{"groupId":"120363430180897172@g.us","senderId":"628123456789@c.us","messageId":"ID-UNIK-WAHA","requester":"Nama anggota","text":"/play judul artis"}
```

Pakai message ID WAHA asli, bukan ID acak per retry. Server menyimpan receipt sebelum menjalankan command dan menserialkan event integrasi. Jika crash/timeout terjadi, periksa antrean; receipt mencegah eksekusi otomatis kedua. Server memberi `reply` untuk dikirim kembali adapter. Identitas dari endpoint dipercaya hanya bila integration token valid: jangan membagikan token kepada anggota.

## Menjalankan dan mengembangkan

Node.js 24 diperlukan karena menggunakan `node:sqlite`.

```powershell
cd I:\website-devops\spotify-player
npm ci
npm run check
npx playwright install chromium
npm run test:browser
docker compose up -d --build
docker compose ps
```

Untuk pengembangan lokal, gunakan `.env` terpisah dengan `APP_ORIGIN=http://127.0.0.1:5173`, jalankan `npm run dev`, buka port 5173. Callback OAuth harus didaftarkan sesuai origin; HTTPS domain lebih cocok untuk Android. Jangan mengganti origin service produksi hanya untuk pengujian lokal. Browser tests memakai server port 3211 dan database memori, tanpa akun atau pesan WAHA nyata.

Kode: `server/spotify-observer.ts` sinkronisasi antrean/playback native, `server/queue.ts` mesin antrean, `server/database.ts` penyimpanan, `server/spotify.ts` OAuth/API, `server/notifications.ts` outbox WAHA, `server/app.ts` API/WebSocket, `src/player.ts` SDK browser, `src/App.tsx` dashboard.

## Backup dan pembaruan

Volume persisten: `spotify-player_player-data`, berisi `/app/data/player.sqlite`. Jangan jalankan `docker compose down -v`. `.env` beserta `ENCRYPTION_KEY` harus dibackup terpisah dengan akses terbatas; database tanpa kunci tersebut tidak bisa memulihkan token Spotify.

```powershell
.\scripts\backup.ps1
docker compose up -d --build
docker compose ps
Invoke-RestMethod http://127.0.0.1:3210/healthz
```

Script backup memakai SQLite VACUUM INTO agar snapshot konsisten meski WAL aktif, lalu menyalin snapshot ke folder `backups` pada host. Backup satu komputer bukan pemulihan bila komputer rusak; salin ke penyimpanan lain. Simpan image lama sampai versi pengganti sehat. Untuk rollback gunakan image versi sebelumnya dengan volume yang sama; hentikan player lebih dulu sebelum mengganti database dari backup. Pemasangan awal ini tidak memiliki database lama untuk diimpor.

Git repo lokal disiapkan; remote belum ditentukan sehingga belum ada push. `.env`, data, backup, dan hasil test tidak masuk Git.
