$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$backupRoot = Join-Path $projectRoot 'backups'
$container = 'spotify-player'
$volume = docker inspect $container --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}'
if ($LASTEXITCODE -ne 0 -or $volume -ne 'spotify-player_player-data') {
    throw 'Volume produksi spotify-player_player-data tidak ditemukan.'
}
$running = docker inspect $container --format '{{.State.Running}}'
if ($LASTEXITCODE -ne 0 -or $running -ne 'true') {
    throw 'Container spotify-player harus berjalan untuk snapshot SQLite. Jangan jalankan backup ini sebelum container aktif.'
}
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
$backupName = 'player-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
$target = Join-Path $backupRoot $backupName
$remotePath = '/app/data/.' + $backupName
if (Test-Path -LiteralPath $target) { throw 'Target backup sudah ada; jangan menimpa backup sebelumnya.' }
$snapshotCode = @'
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const source = '/app/data';
const target = process.argv[1];
fs.mkdirSync(target, { mode: 0o700 });
const rooms = path.join(source, 'rooms');
const files = ['player.sqlite', 'identity.sqlite'].filter(file => fs.existsSync(path.join(source,file)));
if (!files.includes('player.sqlite')) throw new Error('Database player.sqlite produksi tidak ditemukan.');
if (fs.existsSync(rooms)) {
  fs.mkdirSync(path.join(target,'rooms'));
  for (const file of fs.readdirSync(rooms)) if (/^[a-f0-9-]{36}\.sqlite$/.test(file)) files.push('rooms/' + file);
}
for (const file of files) {
  const db = new DatabaseSync(path.join(source,file), { readOnly:true });
  try { db.prepare('VACUUM INTO ?').run(path.join(target,file)); }
  finally { db.close(); }
}
'@
docker exec $container node -e $snapshotCode $remotePath
if ($LASTEXITCODE -ne 0) { throw 'Snapshot SQLite produksi gagal.' }
docker cp "${container}:${remotePath}" $target
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath (Join-Path $target 'player.sqlite'))) {
    throw 'Penyalinan snapshot produksi gagal.'
}
docker exec $container node -e 'require("node:fs").rmSync(process.argv[1],{recursive:true})' $remotePath
if ($LASTEXITCODE -ne 0) { throw 'Snapshot tersalin, tetapi salinan sementara di container belum dihapus.' }
Write-Output ('Backup produksi tersimpan: ' + $target)
