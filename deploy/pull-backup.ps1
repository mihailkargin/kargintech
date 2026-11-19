# ЗАБОР ЗАШИФРОВАННОЙ КОПИИ С СЕРВЕРА НА ПК ВЛАДЕЛЬЦА (13.11.2026).
#
# Запуск на компьютере владельца (PowerShell):
#   .\deploy\pull-backup.ps1
#
# Что делает: по SSH просит Selectel сделать свежую резервную копию, шифрует её
# открытым ключом владельца (openssl cms, AES-256), забирает на этот компьютер
# в папку назначения и оставляет последние 15 копий. Закрытый ключ владельца
# никуда не передаётся — расшифровать копию можно только на этом компьютере
# (deploy\offsite-decrypt.ps1).
#
# Расписание: вручную или планировщиком Windows (taskschd.msc) — например,
# раз в неделю. Ночная копия на сервере делается сама (04:15), этот скрипт
# переносит её вне сервера.
param(
  [string]$Server = 'kargin@SERVER_IP',
  [string]$Dest = "$env:USERPROFILE\OneDrive\Резервные копии\KarginTech-сервер",
  [int]$Keep = 15
)
$ErrorActionPreference = 'Stop'
$ssh = 'C:\Windows\System32\OpenSSH\ssh.exe'
$scp = 'C:\Windows\System32\OpenSSH\scp.exe'

Write-Host "1/4 свежая копия на сервере (займёт минуту)..."
& $ssh -o BatchMode=yes -o ConnectTimeout=30 $Server "cd ~/kargintech/deploy && bash ./backup.sh 2>&1 | tail -2"
if ($LASTEXITCODE -ne 0) { throw "резервная копия на сервере не сделалась (код $LASTEXITCODE)" }

Write-Host "2/4 шифрование для передачи..."
$make = & $ssh -o BatchMode=yes $Server "cd ~/kargintech/deploy && DIR=`$(ls -1d ~/backups/20*_* | sort | tail -1) && bash ./make-pc-copy.sh `"`$DIR`""
$make | Where-Object { $_ -match '^(READY|SIZE):' } | ForEach-Object { Write-Host "   $_" }
$line = $make | Where-Object { $_ -match '^READY:\s*(\S+\.cms)' } | Select-Object -First 1
if (-not $line) { throw "сервер не вернул путь к зашифрованной копии" }
$remote = ([regex]::Match($line, 'READY:\s*(\S+\.cms)')).Groups[1].Value
$sizeLine = $make | Where-Object { $_ -match '^SIZE:\s*(\d+)' } | Select-Object -First 1
$expected = 0
if ($sizeLine -and $sizeLine -match '^РАЗМЕР: (\d+)') { $expected = [int]$Matches[1] }

Write-Host "3/4 забор на этот компьютер..."
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$name = Split-Path $remote -Leaf
& $scp -o BatchMode=yes "${Server}:$remote" (Join-Path $Dest $name)
if ($LASTEXITCODE -ne 0) { throw "файл не доставлен (scp, код $LASTEXITCODE)" }
$local = Get-Item (Join-Path $Dest $name)
if ($expected -gt 0 -and $local.Length -ne $expected) { throw "размер не сошёлся: $($local.Length) вместо $expected" }
Write-Host "   $($local.FullName) ($($local.Length) байт)"

Write-Host "4/4 ротация (храним последние $Keep)..."
Get-ChildItem $Dest -Filter '*.cms' | Sort-Object LastWriteTime -Descending |
  Select-Object -Skip $Keep | ForEach-Object { Remove-Item $_.FullName -Force; Write-Host "   старое удалено: $($_.Name)" }

Write-Host ""
Write-Host "ГОТОВО. Копия вне сервера лежит здесь: $Dest"
Write-Host "Проверка расшифровки (один раз, обязательно):"
Write-Host "   .\deploy\offsite-decrypt.ps1 -Copy `"$Dest\$name`" -Key <путь к owner-key.pem>"
