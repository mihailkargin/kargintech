# Вписывает Kimi API key в .env на сервере. Ключ вводится в окне владельца,
# в чат и локальные файлы проекта не попадает. -Server обязателен.
param([Parameter(Mandatory)][string]$Server)
Add-Type -AssemblyName Microsoft.VisualBasic
$key = [Microsoft.VisualBasic.Interaction]::InputBox('Вставьте ключ Kimi Open Platform (Ctrl+V) и нажмите OK', 'Kimi API key', '')
$key = "$key".Trim()
if (-not $key) { Write-Host 'Ключ не вставлен - ничего не сделано.'; Read-Host 'Enter - закрыть'; exit 1 }
$script = @'
cd ~/kargintech/deploy || exit 1
if grep -q '^KIMI_API_KEY=.' .env; then echo 'Ключ Kimi уже вписан - .env не менял.'; exit 2; fi
cp .env .env.bak-$(date +%s)
sed -i '/^KIMI_API_KEY=$/d;/^KIMI_MODEL=$/d' .env
printf '\nKIMI_API_KEY=%s\nKIMI_MODEL=kimi-k2.8-preview\n' "$KEY" >> .env
echo 'Готово: ключ Kimi записан.'
'@
(@($key) + ($script -split "`r?`n")) -join "`n" |
  & C:\Windows\System32\OpenSSH\ssh.exe $Server "tr -d '\r' | { read -r KEY; export KEY; bash; }"
Read-Host 'Enter - закрыть'
