# Расшифровка копии вне сервера на компьютере владельца (04.11.2026).
#
#     .\deploy\offsite-decrypt.ps1 -Copy <файл .cms> -Key <owner-key.pem>
#
# Даёт рядом с копией архив .tar.gz - тот же каталог, что ночная копия
# (deploy/backup.sh). Его переносят на новый сервер и восстанавливают по
# памятке в конце backup.sh. openssl для этого не нужен.
#
# Копия читается в память целиком: на файл в 1 ГБ нужно около 2-3 ГБ памяти.
param(
    [Parameter(Mandatory)][string]$Copy,
    [Parameter(Mandatory)][string]$Key
)

if ($PSVersionTable.PSVersion.Major -lt 7) {
    $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
    if (-not $pwsh) { Write-Host 'Нужен PowerShell 7: https://aka.ms/powershell' -ForegroundColor Red; exit 1 }
    & $pwsh.Source -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -Copy $Copy -Key $Key
    exit $LASTEXITCODE
}
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$Copy = (Resolve-Path $Copy).Path
$out = [IO.Path]::ChangeExtension($Copy, '.tar.gz')
if (Test-Path $out) {
    Write-Host "Уже есть $out - не перезаписываю. Переименуйте его и запустите снова." -ForegroundColor Yellow
    exit 1
}

$rsa = [System.Security.Cryptography.RSA]::Create()
$rsa.ImportFromPem((Get-Content (Resolve-Path $Key).Path -Raw))

$cms = [System.Security.Cryptography.Pkcs.EnvelopedCms]::new()
$cms.Decode([IO.File]::ReadAllBytes($Copy))
try {
    $cms.Decrypt($cms.RecipientInfos[0], $rsa)
} catch {
    Write-Host "СБОЙ: копия не расшифровывается этим ключом ($($_.Exception.Message))." -ForegroundColor Red
    Write-Host 'Проверьте, что ключ - owner-key.pem из менеджера паролей, а копия скачана целиком.'
    exit 1
}
$data = $cms.ContentInfo.Content
# tar.gz начинается с байтов 1F 8B. Другое начало - расшифровалось не то.
if ($data.Length -lt 2 -or $data[0] -ne 0x1f -or $data[1] -ne 0x8b) {
    Write-Host 'СБОЙ: расшифровалось, но внутри не архив .tar.gz.' -ForegroundColor Red
    exit 1
}
[IO.File]::WriteAllBytes($out, $data)
Write-Host "Готово: $out ($([math]::Round($data.Length / 1MB, 1)) МБ)" -ForegroundColor Green
exit 0
