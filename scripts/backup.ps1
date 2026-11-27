$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$backupRoot = Join-Path $projectRoot 'backups'
$container = 'dev-spotify-player'
$volume = docker inspect $container --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}'
if ($LASTEXITCODE -ne 0 -or $volume -ne 'dev-spotify-player_dev-player-data') {
    throw 'Volume development tidak ditemukan.'
}
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
$backupName = 'dev-player-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
$target = Join-Path $backupRoot $backupName
$remotePath = '/app/data/.' + $backupName
$snapshotCode = @'
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const source = '/app/data';
const target = process.argv[1];
fs.mkdirSync(target, { mode: 0o700 });
const rooms = path.join(source, 'rooms');
const files = ['player.sqlite', 'identity.sqlite'].filter(file => fs.existsSync(path.join(source,file)));
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
if ($LASTEXITCODE -ne 0) { throw 'Snapshot SQLite development gagal.' }
docker cp "${container}:${remotePath}" $target
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath (Join-Path $target 'player.sqlite'))) {
    throw 'Penyalinan snapshot development gagal.'
}
docker exec $container node -e 'require("node:fs").rmSync(process.argv[1],{recursive:true})' $remotePath
if ($LASTEXITCODE -ne 0) { throw 'Snapshot tersalin, tetapi salinan sementara di container belum dihapus.' }
Write-Output ('Backup development tersimpan: ' + $target)
