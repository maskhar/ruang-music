# Ruang Musik · Carubra

Browser player Spotify dengan antrean request bersama. Semua request WhatsApp/web disimpan di server; Spotify hanya menerima satu lagu ketika request mendapat giliran. Audio langsung dari Spotify Web Playback SDK ke browser player.

## Alur aktif

1. `/play judul artis`, URL track, album, atau playlist masuk antrean aplikasi.
2. Server menyimpan track, identitas peminta, ID grup/pesan asal, dan urutan FIFO dalam SQLite.
3. Jika player aktif dan kosong, request pertama mulai otomatis. Request baru tidak mengganti lagu berjalan.
4. Ketika SDK melaporkan lagu selesai, server menjeda continuation Spotify lalu mengirim satu request berikutnya.
5. Setelah URI request terkonfirmasi berjalan, request menjadi Sedang diputar dan notifikasi WAHA menyebut peminta di grup asal.
6. Clear/hapus hanya mengubah request menunggu, tanpa mutation Spotify dan tanpa menghentikan lagu aktif.

Browser hanya menampilkan dan memainkan request. Database server menjadi sumber antrean: refresh, browser tertutup, dan restart container tidak menghapusnya. Browser harus tetap aktif untuk audio dan pergantian lagu otomatis. Jika terputus, aktifkan kembali player; autoplay browser kadang tetap meminta sentuhan.

## WhatsApp

Session `carubra`, credential `WAHA account`. Dua grup berbagi satu player/antrean:

- `120363430180897172@g.us`
- `120363412435389448@g.us`

DM, grup lain, pesan fromMe, media, dan pesan tanpa participant valid diabaikan. Anggota tidak perlu akun web. Balasan/notifikasi kembali ke grup asal, bukan disebar ke seluruh grup.

Workflow utama `mMKGZXtIS2uvso8W` kini menjadi adapter WAHA ke `POST /api/integrations/whatsapp`. Webhook asli dipertahankan. Workflow monitor lama `WJhwejxEcPWJpG6o` dinonaktifkan; notifikasi memakai outbox aplikasi. Tidak ada lagi node Spotify/AI yang memutar langsung pada workflow utama.

| Command | Perilaku |
|---|---|
| `/play judul artis` | Cari hasil track pertama, simpan request, tampilkan judul/artis/tautan |
| `/play URL_TRACK` | Gunakan ID track persis |
| `/play URL_ALBUM` | Masukkan track album sesuai urutan |
| `/playlist URL` atau `/play URL_PLAYLIST` | Urai playlist menjadi track, masukkan antrean; tidak mengganti playback langsung |
| `/play playlist galau` | Pilih playlist relevan pertama Spotify, lalu baca track-nya |
| `/play` atau `/resume` | Lanjutkan request aktif atau mulai request pertama |
| `/queue`, `/antrean`, `/antrian` | Request aktif dan maksimal 10 request menunggu |
| `/clearqueue` | Batalkan seluruh request menunggu; lagu aktif tetap berjalan |
| `/pause` | Jeda; antrean tersimpan dan request baru tidak memulai playback otomatis |
| `/next`, `/skip` | Lewati request aktif dan mulai request berikutnya |
| `/stop` | Jeda player, hentikan request aktif, batalkan semua request menunggu |
| `/vol 0–100`, `/volume` | Kirim kontrol volume ke browser player |
| `/now`, `/np`, `/status` | Request aktif aplikasi |
| `/cari judul artis` | Cari lagu tanpa memutar |
| `/recent`, `/riwayat` | Riwayat request |
| `/help` | Panduan |

`/prev` dan asisten instruksi bebas `/spotify` lama tidak diteruskan; gunakan `/help`. Maksimal 200 track per album/playlist dan 500 request menunggu. Lagu sama boleh diminta beberapa kali sebagai request terpisah.

Playlist personal/playlist buatan Spotify bisa menghasilkan metadata 404 atau daftar track 403. Konsep antrean memerlukan daftar track; request ditolak dengan penjelasan tanpa mengganti lagu, tanpa fallback `context_uri`. Akses playlist yang tidak tersedia tidak dapat diatasi hanya dengan URL. Gunakan track, album, atau playlist yang dapat dibaca oleh aplikasi Spotify.

## Player dan akun

Satu akun Spotify untuk instalasi ini, satu browser sebagai sumber audio. Browser lain bisa login operator dan mengelola antrean. Login Spotify cukup sekali pada server, dengan token refresh terenkripsi. Hubungkan ulang bila Client ID berubah, ingin mengganti akun, atau token/izin tidak valid.

Spotify Premium serta izin aplikasi Spotify diperlukan. Client ID bukan jenis paket Premium; akun Spotify yang login menentukan hak playback. Callback terdaftar:

`https://spotify.carubra.com/auth/spotify/callback`

Domain Cloudflare Tunnel mengarah ke `http://spotify-player:3210` di `carubra-network`. Browser Android memerlukan HTTPS, DRM/Widevine dan dukungan SDK. Volume Android mungkin hanya bisa lewat tombol perangkat. Pemakaian komersial mengikuti ketentuan Spotify.

Saat membuka browser player pertama kali, tekan **Aktifkan player**. Request menunggu dapat mulai otomatis. Penanda tab player tersimpan dalam sessionStorage untuk mencoba pemulihan sesudah refresh; dashboard lain tidak otomatis mengambil alih. Untuk memindahkan audio, gunakan Ambil alih. Saat pause/stop, server menyimpan status jeda; `/resume` melanjutkan.

Antrean native Spotify, playlist continuation, dan autoplay di luar aplikasi tidak diimpor sebagai request. Metadata lagu eksternal masih dapat terlihat sebagai playback luar aplikasi. Request baru menunggu lagu eksternal selesai bila browser player mendeteksinya. Untuk beralih ke antrean aplikasi segera, tekan Putar/berikutnya sesuai kontrol yang tersedia.

## API integrasi

`POST /api/integrations/whatsapp`, Header Auth `Authorization: Bearer <INTEGRATION_TOKEN>`:

```json
{"groupId":"120363430180897172@g.us","senderId":"628123456789@c.us","messageId":"ID-ASLI-WAHA","requester":"Nama anggota","text":"/play judul artis"}
```

Server memeriksa token/grup/participant dan menyimpan receipt per grup+ID pesan sebelum command dijalankan. Duplicate tidak dijalankan atau dibalas ulang oleh adapter. Timeout mutation tidak dicoba ulang otomatis. Error command dikembalikan sebagai `reply` untuk dikirim ke pengguna. N8n harus tersambung ke `carubra-network`.

Notifikasi hanya setelah playback terkonfirmasi, satu outbox per request. Pengiriman ambigu ditandai uncertain tanpa pengiriman ulang otomatis. Kredensial WAHA pada `.env` dipakai outbox aplikasi; credential `WAHA account` pada n8n dipakai balasan command.

## Operasional

Source: `I:\website-devops\spotify-player`. Node.js 24, React/Vite, Express/WebSocket, SQLite. Tidak ada migration PostgreSQL.

```powershell
cd I:\website-devops\spotify-player
npm ci
npm run check
npx playwright install chromium
npm run test:browser
.\scripts\backup.ps1
docker compose up -d --build
docker compose ps
Invoke-RestMethod http://127.0.0.1:3210/healthz
```

Health memiliki `queueMode: application`. Password operator, Client ID, kunci enkripsi, WAHA key, dan integration token berada pada `.env` (diabaikan Git). `WHATSAPP_GROUP_IDS` menerima ID grup dipisahkan koma. Jangan bagikan `.env` atau token akses.

Volume `spotify-player_player-data` berisi `player.sqlite`. Jangan jalankan `docker compose down -v`. Backup SQLite melalui VACUUM INTO ke folder host `backups`; salin juga `.env` secara aman dan simpan backup di perangkat lain. Backup satu komputer bukan pemulihan bila komputer rusak. Simpan image pengganti sebelumnya untuk rollback.

Polling Spotify hanya membaca `/me/player`, maksimal sekali per 15 detik untuk metadata/volume, dan mengikuti Retry-After saat 429. Antrean berasal dari SQLite dan broadcast WebSocket, sehingga tidak perlu membaca endpoint queue Spotify. SDK browser melaporkan progress setiap 3 detik.

## Cutover dan rollback

Backup workflow sebelum perubahan tersedia di `backups/app-queue-cutover-20261127`, database via script backup. Script `scripts/n8n/app-queue-cutover.cjs` menggunakan helper API n8n pada container, menyiapkan Header Auth terenkripsi, mempertahankan webhook utama, lalu menonaktifkan monitor lama. Script `scripts/n8n/test-app-queue-adapter.cjs` menguji adapter secara terisolasi, tanpa pesan nyata.

Rollback integrasi: pulihkan JSON workflow utama dari backup melalui API/import, aktifkan workflow utama dan monitor lama, lalu gunakan image sebelum app-queue. Jangan jalankan monitor lama dan outbox baru untuk request yang sama. Request yang sudah tersimpan di SQLite tetap dipertahankan. Riwayat/pending lama n8n tetap tersimpan dalam tabel lama dan tidak diimpor otomatis karena tidak dapat dipastikan masih valid.

Remote Git belum ditentukan; commit lokal tersedia, belum bisa push.

## Lingkungan pengembangan maskhar-dev

Worktree pengembangan: `I:\website-devops\spotify-player-dev`, branch `maskhar-dev`.
Produksi tetap pada `I:\website-devops\spotify-player`, branch `main`.

Development memakai container/image `dev-spotify-player`, port `http://127.0.0.1:3211`, volume `dev-spotify-player_dev-player-data`, dan jaringan Compose tersendiri. Database dimulai kosong; token Spotify, data request, dan konfigurasi WAHA produksi tidak disalin. Password operator awal sama dengan produksi agar operator dapat login; `.env`, kunci enkripsi, dan integration token development terpisah.

Spotify Client ID dan WAHA dinonaktifkan melalui Compose. Jangan hubungkan akun Spotify produksi untuk pengujian karena satu akun Spotify berbagi playback antarperangkat meskipun database terpisah. Untuk pengujian audio, gunakan akun Premium serta Spotify Developer App pengujian dan daftarkan callback origin development. Untuk WAHA gunakan session dan grup pengujian terpisah sebelum mengaktifkan integrasi.

Jalankan build/deploy development hanya dari worktree development:

```powershell
cd I:\website-devops\spotify-player-dev
docker compose up -d --build
docker compose ps
```

Deploy perintah ini tidak mengganti container/volume produksi. Jangan memakai volume produksi atau menjalankan `docker compose down -v`. Perubahan branch development baru masuk produksi melalui proses merge yang disengaja. Image ini tetap memakai build production untuk hasil uji yang konsisten; kode baru tersedia setelah build ulang.

Domain development: `https://dev-spotify.carubra.com`.
Spotify callback: `https://dev-spotify.carubra.com/auth/spotify/callback`.
Tambahkan Published application route pada Cloudflare Tunnel carubra untuk hostname `dev-spotify.carubra.com` dengan service HTTP `http://dev-spotify-player:3210`.
Container development terhubung ke `carubra-network` untuk ingress tunnel; volume/database tetap terpisah. Port localhost 3211 tetap tersedia untuk health check. Login/operator memakai domain HTTPS karena cookie Secure mengikuti APP_ORIGIN.
