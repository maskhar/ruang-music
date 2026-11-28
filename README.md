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

Session `carubra`, credential `WAHA account`. Hubungkan grup ke ruang dengan `/hubungkan KODE`. Simpan grup di pengaturan ruang melalui pairing. Anggota grup tertaut dapat meminta lagu tanpa akun web. Balasan dan notifikasi dikirim ke grup asal. Bot mengabaikan DM, pesan dari nomor bot, media, dan command dari grup yang belum tertaut, kecuali `/hubungkan`.

Workflow utama `mMKGZXtIS2uvso8W` kini menjadi adapter WAHA ke `POST /api/integrations/whatsapp`. Webhook asli dipertahankan. Workflow monitor lama `WJhwejxEcPWJpG6o` dinonaktifkan; notifikasi memakai outbox aplikasi. Tidak ada lagi node Spotify/AI yang memutar langsung pada workflow utama.

| Command | Perilaku |
|---|---|
| `/hubungkan KODE` | Pasangkan grup ke ruang menggunakan kode dari dashboard |
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

Setiap ruang memakai akun Spotify dan browser player sendiri. Operator dapat mengelola antrean dari browser lain. Server menyimpan token refresh terenkripsi per ruang. Hubungkan ulang bila Client ID berubah, ingin mengganti akun, atau token/izin kedaluwarsa.

Spotify Premium serta izin aplikasi Spotify diperlukan. Client ID bukan jenis paket Premium; akun Spotify yang login menentukan hak playback. Callback terdaftar:

`https://spotify.carubra.com/auth/spotify/callback`

Domain Cloudflare Tunnel mengarah ke `http://spotify-player:3210` di `carubra-network`. Browser Android memerlukan HTTPS, DRM/Widevine dan dukungan SDK. Volume Android mungkin hanya bisa lewat tombol perangkat. Pemakaian komersial mengikuti ketentuan Spotify.

Saat membuka browser player pertama kali, tekan **Aktifkan player**. Request menunggu dapat mulai otomatis. Penanda tab player tersimpan dalam sessionStorage untuk mencoba pemulihan sesudah refresh; dashboard lain tidak otomatis mengambil alih. Untuk memindahkan audio, gunakan Ambil alih. Saat pause/stop, server menyimpan status jeda; `/resume` melanjutkan.

Antrean native Spotify, playlist continuation, dan autoplay di luar aplikasi tidak diimpor sebagai request. Metadata lagu eksternal masih dapat terlihat sebagai playback luar aplikasi. Request baru menunggu lagu eksternal selesai bila browser player mendeteksinya. Untuk beralih ke antrean aplikasi segera, tekan Putar/berikutnya sesuai kontrol yang tersedia.

## API integrasi

`POST /api/integrations/whatsapp`, Header Auth `Authorization: Bearer <INTEGRATION_TOKEN>`:

```json
{"session":"carubra","groupId":"123456789@g.us","senderId":"628123456789@c.us","messageId":"ID-ASLI-WAHA","requester":"Nama anggota","text":"/play judul artis"}
```

Server memeriksa token/grup/participant dan menyimpan receipt per grup+ID pesan sebelum command dijalankan. Duplicate tidak dijalankan atau dibalas ulang oleh adapter. Timeout mutation tidak dicoba ulang otomatis. Error command dikembalikan sebagai `reply` untuk dikirim ke pengguna. N8n harus tersambung ke `carubra-network`.

Notifikasi hanya setelah playback terkonfirmasi, satu outbox per request. Pengiriman ambigu ditandai uncertain tanpa pengiriman ulang otomatis. Kredensial WAHA pada `.env` dipakai outbox aplikasi; credential `WAHA account` pada n8n dipakai balasan command.

## Operasional

Source produksi: `I:\website-devops\spotify-player`, branch `main`. Node.js 24, React/Vite, Express/WebSocket, SQLite.

```powershell
cd I:\website-devops\spotify-player
npm ci
npm run check
npx playwright install chromium
npm run test:browser
.\scripts\backup.ps1
docker compose up -d --build --wait player
docker compose ps
Invoke-RestMethod https://spotify.carubra.com/healthz
```

Health menampilkan `queueMode: application` dan `rooms: true`. Password admin, Client ID, kunci enkripsi, WAHA key, dan integration token berada pada `.env` (diabaikan Git). Hapus `WHATSAPP_GROUP_ID` dan `WHATSAPP_GROUP_IDS` saat beralih ke pairing. Saat development memakai session WAHA yang sama, masukkan grup uji development ke `WHATSAPP_BLOCKED_GROUP_IDS` produksi dan set `REQUIRE_WHATSAPP_GROUP_BLOCKLIST=true`.

Volume `spotify-player_player-data` menyimpan data produksi. Perintah `scripts/backup.ps1` mengambil snapshot SQLite ke folder host `backups`. Simpan juga `.env` secara aman karena kunci enkripsi diperlukan saat pemulihan. Simpan semua file dalam satu set backup untuk pemulihan multi-ruang.

Polling Spotify hanya membaca `/me/player`, maksimal sekali per 15 detik untuk metadata/volume, dan mengikuti Retry-After saat 429. Antrean berasal dari SQLite dan broadcast WebSocket, sehingga tidak perlu membaca endpoint queue Spotify. SDK browser melaporkan progress setiap 3 detik.

## Cutover dan rollback

Cadangkan volume SQLite dan `.env` sebelum deploy. `scripts/n8n/update-production-routing.cjs` menyiapkan routing produksi berdasarkan pairing, membatasi workflow development ke grup uji, dan mencadangkan workflow sebelum menerbitkan perubahan. Script mempertahankan webhook dan credential. Jika perlu rollback, gunakan workflow, konfigurasi, dan versi aplikasi sebelum migrasi sebagai satu set dan pertahankan data request yang telah tersimpan.

Remote Git: `https://github.com/maskhar/ruang-music.git`.

## Lingkungan pengembangan maskhar-dev

Worktree pengembangan: `I:\website-devops\spotify-player-dev`, branch `maskhar-dev`.
Produksi tetap pada `I:\website-devops\spotify-player`, branch `main`.

Development memakai container/image `dev-spotify-player`, port `http://127.0.0.1:3211`, volume `dev-spotify-player_dev-player-data`, dan jaringan Compose tersendiri. Database dimulai kosong; token Spotify, data request, dan konfigurasi WAHA produksi tidak disalin. Password operator awal sama dengan produksi agar operator dapat login; `.env`, kunci enkripsi, dan integration token development terpisah.

Spotify Client ID dan WAHA dibaca dari `.env` development. Gunakan akun Premium pengujian karena playback mengikuti akun Spotify di semua perangkat. Tambahkan akun pengujian ke Spotify Developer App sesuai izin aplikasi. WAHA menggunakan session `carubra` dan grup pengujian yang didaftarkan di `.env` development.

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

### Integrasi development

Compose membaca `SPOTIFY_CLIENT_ID`, `WAHA_URL`, `WAHA_API_KEY`, dan `WAHA_SESSION` dari `.env` worktree development. `WHATSAPP_GROUP_IDS` hanya dipakai untuk binding Ruang utama saat database identitas pertama kali dibuat. Development mewajibkan `WHATSAPP_BLOCKED_GROUP_IDS` berisi ID grup produksi yang dilayani oleh session WAHA bersama. Setelah mengubah `.env`, jalankan `docker compose up -d --force-recreate` dari worktree development.

Workflow n8n development `xanTFAOSvArYVB9E` hanya menerima ID grup uji yang ditentukan saat routing produksi disiapkan. Saat mengganti grup uji, perbarui filter workflow development dan `WHATSAPP_BLOCKED_GROUP_IDS` produksi bersama agar kedua lingkungan terpisah. Webhook tetap dipakai. Credential API development terpisah dari produksi.

## Multi-ruang

Login admin awal memakai `owner@local` dan `ADMIN_PASSWORD` pada `.env` lingkungan yang dibuka. Dashboard awal menampilkan kartu ruang, status pemutar, jumlah request, serta koneksi Spotify dan WhatsApp. Admin melihat semua ruang, pengguna lainnya melihat ruang sesuai akses. Pilih **Buka ruang** untuk masuk ke player dan antrean ruang. Pemilik ruang dapat mengundang anggota atau operator dari Pengaturan. Tautan undangan berlaku 24 jam dan sekali pakai. Akun yang sudah terdaftar langsung ditambahkan ke ruang dengan peran yang dipilih.

Anggota dapat mencari dan meminta lagu. Operator dapat mengatur player dan antrean. Pemilik dan operator dapat memasangkan grup WhatsApp dan menghubungkan Spotify. Pemilik juga dapat melepas grup serta mengelola keanggotaan.

Hubungkan akun Spotify Premium berbeda untuk setiap ruang yang akan memutar bersamaan. Browser yang aktif mengeluarkan audio untuk ruang yang dipilih.

Untuk memasangkan grup:

1. Buat ruang dan buka **Pengaturan**. Tempel tautan grup `https://chat.whatsapp.com/…`, lalu pilih **Gabungkan Carubra**. Jika WhatsApp meminta persetujuan, admin grup perlu menyetujui permintaan masuk. Menambahkan nomor Carubra secara manual juga tetap tersedia.
2. Setelah Carubra masuk, salin perintah `/hubungkan KODE` lalu kirim dari grup tersebut. Kode berlaku 10 menit dan sekali pakai. Setelah kedaluwarsa, buat kode baru dari Pengaturan.
3. Bot memeriksa pesan melalui WAHA, lalu mengonfirmasi nama ruang dan status Spotify di grup. Jika Spotify belum terhubung, hubungkan akun Premium dari Pengaturan. Bot mengirim kabar saat Spotify berhasil terhubung. Aktifkan browser player pada perangkat yang mengeluarkan suara.

Satu grup hanya dapat dipasangkan ke satu ruang. Pemilik perlu melepas grup dari ruang asal sebelum memasangkannya ke ruang baru. Antrean dan riwayat tetap tersimpan di ruang asal. Workflow n8n produksi meneruskan command semua ruang, termasuk pairing, ke aplikasi.

Pemilik atau admin dapat membuka **Pengaturan → Akses kontrol WhatsApp**, memilih grup, lalu klik **Muat anggota grup**. Centang anggota yang boleh mengontrol musik dan simpan. Daftar izin berlaku per grup untuk `/next` (`/skip`), `/stop`, `/pause`, dan `/volume` (`/vol`). Jika daftar kosong, command tersebut tidak bisa dijalankan lewat WhatsApp. Server memeriksa kembali keanggotaan grup untuk kontrol. Command request lagu dan peran dashboard mengikuti aturan sebelumnya.

Database `player.sqlite` lama tetap dipakai oleh Ruang utama, termasuk antrean dan koneksi Spotify yang sudah tersimpan. `identity.sqlite` menyimpan akun dan keanggotaan. Ruang baru memiliki database sendiri di `rooms/`. Gunakan `scripts/backup.ps1` untuk mencadangkan ketiganya.

Pemilik atau admin bisa menghapus ruang dari kartu dashboard. Penghapusan mencabut akses, undangan, player, koneksi Spotify, dan ikatan WhatsApp untuk ruang tersebut. Antrean dan riwayat disimpan di SQLite sebagai arsip pemulihan; ruang yang dihapus tidak kembali setelah restart.
