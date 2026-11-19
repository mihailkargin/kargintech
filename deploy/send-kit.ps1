# Перенос комплекта на сервер с компьютера владельца (04.11.2026).
#
#   Основной сервер:   .\deploy\send-kit.ps1 -Server kargin@<адрес>
#   Запасной (Сингапур): .\deploy\send-kit.ps1 -Server kargin@ABROAD_IP -Abroad
#
# Основной получает в ~/kargintech код и воркфлоу (src, app, site, deploy, n8n, package.json),
# запасной в ~/kargintech-abroad - только deploy/abroad и программу приёма копий.
# .env, ключи и данные клиентов не передаются: их в комплекте нет.
# Если сервер спросит пароль - вводите его здесь, в этом окне.
param(
    [Parameter(Mandatory)][string]$Server,
    [switch]$Abroad
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

if ($Abroad) {
    $parts = 'deploy/abroad deploy/backup-offsite-receive.sh'
    $dest = '~/kargintech-abroad'
} else {
    $parts = 'src app site deploy n8n package.json'
    $dest = '~/kargintech'
}
foreach ($p in $parts -split ' ') {
    if (-not (Test-Path $p)) { Write-Host "Нет $p в папке проекта - остановлено." -ForegroundColor Red; exit 1 }
}

# Через cmd: так байты архива идут в ssh без перекодировки (Windows PowerShell 5.1
# портит двоичные данные между программами).
$excl = '--exclude=deploy/.env --exclude=deploy/.env.bak* --exclude=__pycache__ --exclude=*.pyc'
$remote = "mkdir -p $dest && tar xzf - -C $dest && echo ПРИНЯТО: && cd $dest && find . -type f | wc -l"
cmd /c "tar -czf - $excl $parts | C:\Windows\System32\OpenSSH\ssh.exe $Server `"$remote`""
if ($LASTEXITCODE -ne 0) { Write-Host 'Передача не прошла - смотрите сообщение выше.' -ForegroundColor Red; exit 1 }

$count = (cmd /c "tar -czf - $excl $parts | tar -tzf -" | Where-Object { $_ -notmatch '/$' }).Count
Write-Host "Отправлено файлов: $count. Число после «ПРИНЯТО:» должно быть не меньше." -ForegroundColor Green
