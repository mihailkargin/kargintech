# Вписывает ключ Yandex Cloud в .env на сервере. Запускает владелец сам:
# ключ из окна уходит прямо на сервер, в чат и в файлы на этом компьютере не попадает.
# Перед записью .env копируется в .env.bak-<время>; если ключ уже вписан - ничего не меняет.
# -Proba: проверить связь и передачу, .env не трогать; -Server обязателен, чтобы
# новый сервер нельзя было случайно заменить прежним адресом по умолчанию.
param([switch]$Proba, [Parameter(Mandatory)][string]$Server)
Add-Type -AssemblyName Microsoft.VisualBasic
$key = [Microsoft.VisualBasic.Interaction]::InputBox('Вставьте секретный ключ Yandex Cloud (Ctrl+V) и нажмите OK', 'Ключ Yandex Cloud', '')
$key = "$key".Trim()
if (-not $key) { Write-Host 'Ключ не вставлен - ничего не сделано.'; Read-Host 'Enter - закрыть'; exit 1 }

$write = if ($Proba) { 'echo "Проба: .env не менялся."' } else { @'
if grep -q '^YANDEX_API_KEY=.' .env; then echo 'Ключ уже вписан раньше - .env не менял.'; exit 2; fi
cp .env .env.bak-$(date +%s)
# Пустые строки из .env.example убираются, чтобы ключ не был записан дважды.
sed -i '/^YANDEX_API_KEY=$/d;/^YANDEX_FOLDER_ID=$/d' .env
printf '\nYANDEX_API_KEY=%s\nYANDEX_FOLDER_ID=b1g0g13647pl65vthcoi\n' "$KEY" >> .env
echo 'Готово: ключ записан.'
'@ }
$script = @"
cd ~/kargintech/deploy || exit 1
echo "Ключ дошёл до сервера, длина `$(printf %s "`$KEY" | wc -c) знаков."
$write
"@

# Первая строка - ключ, дальше - команды; ключ не попадает в командную строку и журналы.
(@($key) + ($script -split "`r?`n")) -join "`n" |
  & C:\Windows\System32\OpenSSH\ssh.exe $Server "tr -d '\r' | { read -r KEY; export KEY; bash; }"
Read-Host 'Enter - закрыть'
