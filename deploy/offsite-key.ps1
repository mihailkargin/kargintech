# Ключ шифрования копий вне сервера (04.11.2026).
#
# Запуск на компьютере владельца, один раз:
#     cd "C:\Users\Honor\Desktop\Тендеры Автоматизации"
#     .\deploy\offsite-key.ps1
#
# Создаёт пару: открытый ключ owner-cert.pem уходит на основной сервер, им
# ночная копия шифруется (deploy/backup-offsite.sh); закрытый owner-key.pem
# остаётся здесь и переносится в менеджер паролей. Пара создаётся на этом
# компьютере, а не на сервере: закрытый ключ ни на одном сервере не бывает,
# и захват сервера копии не раскрывает.
#
# Потеря закрытого ключа = все копии вне сервера не расшифровать. Поэтому
# скрипт не перезаписывает уже существующую пару.
param([string]$Dir = (Join-Path $env:USERPROFILE 'KarginTech-offsite-key'))

if ($PSVersionTable.PSVersion.Major -lt 7) {
    # В Windows PowerShell 5.1 нет нужных функций .NET - перезапуск в PowerShell 7.
    $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
    if (-not $pwsh) { Write-Host 'Нужен PowerShell 7: https://aka.ms/powershell' -ForegroundColor Red; exit 1 }
    & $pwsh.Source -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -Dir $Dir
    exit $LASTEXITCODE
}
$ErrorActionPreference = 'Stop'

$dir = $Dir
$key = Join-Path $dir 'owner-key.pem'
$cert = Join-Path $dir 'owner-cert.pem'
if ((Test-Path $key) -or (Test-Path $cert)) {
    Write-Host "Пара уже есть в $dir - новую не создаю, чтобы не потерять старую." -ForegroundColor Yellow
    Write-Host 'Если старая точно не нужна (ни одной копии ею не зашифровано) - переименуйте папку и запустите снова.'
    exit 1
}
New-Item -ItemType Directory -Force $dir | Out-Null

$rsa = [System.Security.Cryptography.RSA]::Create(4096)
$req = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    'CN=KarginTech offsite backup', $rsa,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$req.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment, $true))
# Срок 30 лет: ключ не для входа, а для шифрования копий; истёкший срок
# не должен однажды ночью остановить копирование.
$now = [DateTimeOffset]::UtcNow
$c = $req.CreateSelfSigned($now.AddDays(-1), $now.AddYears(30))

[IO.File]::WriteAllText($cert, $c.ExportCertificatePem() + "`n")
[IO.File]::WriteAllText($key, $rsa.ExportPkcs8PrivateKeyPem() + "`n")

# Сразу проверяем, что пара рабочая: шифруем пробный текст открытым ключом
# и расшифровываем закрытым - тем же способом, что у копий.
Add-Type -AssemblyName System.Security
$probe = [Text.Encoding]::UTF8.GetBytes('проверка пары ' + [guid]::NewGuid())
$env1 = [System.Security.Cryptography.Pkcs.EnvelopedCms]::new(
    [System.Security.Cryptography.Pkcs.ContentInfo]::new($probe),
    [System.Security.Cryptography.Pkcs.AlgorithmIdentifier]::new([System.Security.Cryptography.Oid]::new('2.16.840.1.101.3.4.1.42')))
$env1.Encrypt([System.Security.Cryptography.Pkcs.CmsRecipient]::new(
    [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem((Get-Content $cert -Raw))))
$env2 = [System.Security.Cryptography.Pkcs.EnvelopedCms]::new()
$env2.Decode($env1.Encode())
$k2 = [System.Security.Cryptography.RSA]::Create(); $k2.ImportFromPem((Get-Content $key -Raw))
$env2.Decrypt($env2.RecipientInfos[0], $k2)
if (-not [Linq.Enumerable]::SequenceEqual([byte[]]$env2.ContentInfo.Content, [byte[]]$probe)) {
    Write-Host 'СБОЙ: пробная шифровка не расшифровалась - пару не использовать.' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host "Готово, пара проверена (шифровка и расшифровка пробного текста)." -ForegroundColor Green
Write-Host "  Папка: $dir"
Write-Host ''
Write-Host '1. owner-key.pem - ЗАКРЫТЫЙ. Перенесите файл в менеджер паролей (вложением). Никому не отправлять, на серверы не класть.'
Write-Host '2. owner-cert.pem - открытый. Его содержимое вставляется на основной сервер (команду пришлёт сессия «Разработка»).'
Write-Host "   Отпечаток для сверки: $($c.Thumbprint)"
exit 0
