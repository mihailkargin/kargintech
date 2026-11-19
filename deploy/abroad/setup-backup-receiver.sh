#!/usr/bin/env bash
# Приём копий на запасном сервере (Сингапур, 04.11.2026).
#
# Запускать ОДИН РАЗ на запасном сервере, от пользователя с sudo, передав
# открытый ssh-ключ основного сервера одной строкой в кавычках:
#
#     bash setup-backup-receiver.sh "ssh-ed25519 AAAA... kargin@main"
#
# Что делает:
#   1. пользователь backup без пароля - войти можно только ключом;
#   2. программа приёма /usr/local/bin/kargintech-backup-receive, владелец root:
#      пользователь backup не может её подменить;
#   3. ключ основного сервера в authorized_keys с command=...,restrict - этот
#      ключ может только отдать копию: ни оболочки, ни чтения, ни удаления.
#      Сам authorized_keys принадлежит root, добавить себе ключей backup не может;
#   4. печатает строку для known_hosts основного сервера - чтобы основной
#      отправлял копии только этому серверу, а не подставному.
#
# Чего НЕ делает: не трогает sshd_config, сетевой экран и других пользователей.
set -euo pipefail

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  OK   %s\n' "$*"; }
bad() { printf '  СБОЙ %s\n' "$*"; }

if [[ $EUID -eq 0 ]]; then
  bad "Запускать не от root, а от обычного пользователя с sudo."
  exit 1
fi
KEY="${1:-}"
if [[ ! "$KEY" =~ ^ssh-(ed25519|rsa)\ [A-Za-z0-9+/=]+(\ .*)?$ ]]; then
  bad "Первым аргументом нужен открытый ключ основного сервера: \"ssh-ed25519 AAAA...\""
  exit 1
fi
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
RECEIVE="$SRC_DIR/../backup-offsite-receive.sh"
[[ -f "$RECEIVE" ]] || RECEIVE="$SRC_DIR/backup-offsite-receive.sh"
if [[ ! -f "$RECEIVE" ]]; then
  bad "Не найден backup-offsite-receive.sh рядом со скриптом."
  exit 1
fi

say "1. Пользователь backup"
if id backup-kt >/dev/null 2>&1; then
  ok "уже есть"
else
  sudo adduser --disabled-password --gecos 'KarginTech backups' backup-kt >/dev/null
  ok "создан, пароля нет"
fi
HOME_DIR="$(getent passwd backup-kt | cut -d: -f6)"

say "2. Программа приёма"
sudo install -o root -g root -m 755 "$RECEIVE" /usr/local/bin/kargintech-backup-receive
ok "/usr/local/bin/kargintech-backup-receive"

say "3. Ключ основного сервера"
sudo install -d -o root -g backup-kt -m 750 "$HOME_DIR/.ssh"
LINE="command=\"/usr/local/bin/kargintech-backup-receive\",restrict $KEY"
echo "$LINE" | sudo tee "$HOME_DIR/.ssh/authorized_keys" >/dev/null
sudo chown root:backup-kt "$HOME_DIR/.ssh/authorized_keys"
sudo chmod 640 "$HOME_DIR/.ssh/authorized_keys"
ok "ключ записан с ограничением command=...,restrict"

say "4. Место на диске"
FREE_GB=$(df -Pk "$HOME_DIR" | awk 'NR==2 {printf "%d", $4/1048576}')
echo "  свободно: ${FREE_GB} ГБ"
if [[ "$FREE_GB" -lt 20 ]]; then
  bad "меньше 20 ГБ: 30 ежедневных и 12 недельных копий могут не поместиться"
else
  ok "места достаточно"
fi

say "5. Пробный приём (как это сделает основной сервер)"
TMP="$(mktemp)"
{ printf '\x30'; head -c 4096 /dev/urandom; } > "$TMP"
GOT="$(sudo -u backup-kt -H /usr/local/bin/kargintech-backup-receive < "$TMP" | tr -dc '0-9')"
if [[ "$GOT" == "$(stat -c %s "$TMP")" ]]; then
  ok "принято $GOT байт"
else
  bad "пробный приём не прошёл (получено: ${GOT:-ничего})"
  rm -f "$TMP"; exit 1
fi
printf 'x' > "$TMP"
if sudo -u backup-kt -H /usr/local/bin/kargintech-backup-receive < "$TMP" >/dev/null 2>&1; then
  bad "мусор в 1 байт принят - защита от вытеснения копий не работает"
  rm -f "$TMP"; exit 1
fi
ok "мусор не принят"
rm -f "$TMP"
# Пробные файлы убираем, чтобы не путались с настоящими копиями.
sudo find "$HOME_DIR/incoming" "$HOME_DIR/weekly" -name '*.cms' -size -6k -delete

say "Готово. На ОСНОВНОМ сервере добавить в ~/.ssh/known_hosts строку:"
IP=$(curl -s --max-time 15 https://api.ipify.org || echo 'АДРЕС_ЭТОГО_СЕРВЕРА')
echo "  $IP $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
echo
echo "  и в deploy/.env: OFFSITE_HOST=backup-kt@$IP"
