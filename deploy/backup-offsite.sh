#!/usr/bin/env bash
#
# КОПИЯ ВНЕ ОСНОВНОГО СЕРВЕРА - после аварии Beget 02.11.2026: ночные копии
# лежали в ~/backups на том же сервере, и при потере его дисков восстанавливать
# было бы не из чего (БЕЗОПАСНОСТЬ.md требовала «на отдельном носителе» с 07.10,
# сделано не было).
#
# Запускается из backup.sh после успешной местной копии:
#     bash ./backup-offsite.sh <каталог копии>
#
# КАК УСТРОЕНО
#   1. Каталог копии упаковывается и ШИФРУЕТСЯ открытым ключом владельца
#      (openssl cms, AES-256). Закрытый ключ хранится только у владельца - в
#      менеджере паролей. На основном и на запасном сервере его нет, поэтому
#      захват любого из них копию не раскрывает: в ней .env с ключами и данные
#      клиентов.
#   2. Шифровка уходит на запасной сервер по ssh. Ключ этого сервера на
#      запасном привязан к одной команде (backup-offsite-receive.sh): «принять
#      файл и назвать его размер». Ни оболочки, ни чтения, ни удаления; мусор
#      не принимается, недельные копии вытеснить нельзя. Настройка запасного -
#      deploy/abroad/setup-backup-receiver.sh.
#   3. Размер, названный запасным сервером, сверяется с отправленным. Совпал -
#      пишется отметка state/backup-offsite-ok; её проверяет самопроверка сервиса
#      и шлёт владельцу сигнал, если копии вне сервера нет больше 26 часов.
#
# Настройки - в .env (читаются текстом, не исполняются):
#   OFFSITE_HOST=backup-kt@ABROAD_IP   пользователь и адрес запасного сервера
#   (не backup@: в Ubuntu это занятое системное имя)
#   OFFSITE_CERT=/home/kargin/.offsite/owner-cert.pem   открытый ключ владельца
set -euo pipefail

SRC="${1:?укажите каталог копии}"
cd "$(dirname "$0")"

env_value() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" ./.env | head -n 1 | tr -d '\r' \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}
HOST="$(env_value OFFSITE_HOST)"
CERT="$(env_value OFFSITE_CERT)"
PROJECT="${COMPOSE_PROJECT_NAME:-$(basename "$(pwd)" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')}"

if [ -z "$HOST" ] || [ -z "$CERT" ]; then
  echo "ВНЕ СЕРВЕРА: не настроено (нет OFFSITE_HOST или OFFSITE_CERT в .env) - копия только на этом сервере"
  exit 2
fi
if [ ! -s "$CERT" ]; then
  echo "ВНЕ СЕРВЕРА: ОШИБКА - открытого ключа $CERT нет"
  exit 1
fi

OUT="$(mktemp /tmp/offsite.XXXXXX)"
trap 'rm -f "$OUT"' EXIT
chmod 600 "$OUT"

# Шифрование потоком: незашифрованный архив на диск не пишется.
tar czf - -C "$(dirname "$SRC")" "$(basename "$SRC")" \
  | openssl cms -encrypt -binary -aes256 -outform DER "$CERT" > "$OUT"
SIZE="$(stat -c %s "$OUT")"
if [ "$SIZE" -lt 1024 ]; then
  echo "ВНЕ СЕРВЕРА: ОШИБКА - шифровка подозрительно мала ($SIZE байт)"
  exit 1
fi

# Проверка, что шифровка - настоящий CMS-конверт, а не ошибка openssl в файле.
if ! openssl cms -cmsout -inform DER -in "$OUT" -noout 2>/dev/null; then
  echo "ВНЕ СЕРВЕРА: ОШИБКА - шифровка не читается как CMS"
  exit 1
fi

echo "-- копия вне сервера: $(basename "$SRC"), $SIZE байт -> $HOST --"
GOT="$(ssh -o BatchMode=yes -o ConnectTimeout=30 -o StrictHostKeyChecking=yes "$HOST" < "$OUT" | tr -dc '0-9')"
if [ "$GOT" != "$SIZE" ]; then
  echo "ВНЕ СЕРВЕРА: ОШИБКА - запасной сервер принял ${GOT:-0} байт из $SIZE"
  exit 1
fi
echo "   принято целиком: $GOT байт"

docker run --rm -v "${PROJECT}_app_data:/v" alpine:3 \
  sh -c "mkdir -p /v/state && date -u +%Y-%m-%dT%H:%M:%SZ > /v/state/backup-offsite-ok"
