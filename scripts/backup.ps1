$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$backupRoot = Join-Path $projectRoot 'backups'
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
$backupName = 'player-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.sqlite'
$containerBackup = '/app/data/' + $backupName
$backupCode = 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("/app/data/player.sqlite");db.prepare("VACUUM INTO ?").run(process.argv[1]);db.close();'
docker exec spotify-player node -e $backupCode $containerBackup
if ($LASTEXITCODE -ne 0) { throw 'Snapshot SQLite gagal.' }
docker cp "spotify-player:$containerBackup" (Join-Path $backupRoot $backupName)
if ($LASTEXITCODE -ne 0) { throw 'Penyalinan backup gagal.' }
docker exec spotify-player node -e 'require("node:fs").unlinkSync(process.argv[1])' $containerBackup
Write-Output ('Backup tersimpan: ' + (Join-Path $backupRoot $backupName))
