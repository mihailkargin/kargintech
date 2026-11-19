# Добавляет публичный ключ владельца на запасном сервере. Пароль вводится только
# в окне SSH, в чат и файлы не записывается. Повторный запуск не дублирует ключ.
$ErrorActionPreference = 'Stop'
$keyPath = Join-Path $env:USERPROFILE '.ssh\id_ed25519.pub'
if (-not (Test-Path $keyPath)) { Write-Host "Нет $keyPath" -ForegroundColor Red; Read-Host 'Enter - закрыть'; exit 1 }
$remote = @'
set -e
key=$(cat)
install -d -m 700 -o kargin -g kargin /home/kargin/.ssh
touch /home/kargin/.ssh/authorized_keys
chown kargin:kargin /home/kargin/.ssh/authorized_keys
chmod 600 /home/kargin/.ssh/authorized_keys
printf '%s\n' "$key" | grep -qxF -f - /home/kargin/.ssh/authorized_keys || printf '%s\n' "$key" >> /home/kargin/.ssh/authorized_keys
echo KEY_ADDED
'@
Get-Content $keyPath -Raw | & C:\Windows\System32\OpenSSH\ssh.exe root@ABROAD_IP $remote
if ($LASTEXITCODE -ne 0) { Write-Host 'Ключ не добавлен - проверьте пароль.' -ForegroundColor Red; Read-Host 'Enter - закрыть'; exit 1 }
& C:\Windows\System32\OpenSSH\ssh.exe -o BatchMode=yes kargin@ABROAD_IP 'echo KEY_LOGIN_OK'
Read-Host 'Enter - закрыть'
