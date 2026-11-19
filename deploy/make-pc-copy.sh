#!/usr/bin/env bash
#
# ЗАШИФРОВАННАЯ КОПИЯ ДЛЯ ПК ВЛАДЕЛЬЦА (13.11.2026). Сингапур не используется
# (решение владельца 11.11): вне сервера копия живёт на компьютере владельца,
# этот скрипт готовит её к отдаче, а забор делает deploy/pull-backup.ps1 с ПК.
#
# Запуск на Selectel:
#     bash ./make-pc-copy.sh <каталог копии из ~/backups>
#       например: bash ./make-pc-copy.sh ~/backups/2026-11-13_0415
#
# На выходе: ~/backups-pc/<имя>.cms — tar.gz, зашифрованный открытым ключом
# владельца (openssl cms, AES-256). Печатает путь и размер; расшифровывается
# только закрытым ключом владельца (deploy/offsite-decrypt.ps1 на ПК).
set -euo pipefail

SRC="${1:?укажите каталог копии: bash ./make-pc-copy.sh ~/backups/<каталог>}"
cd "$(dirname "$0")"

env_value() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" ./.env | head -n 1 | tr -d '\r' \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}
CERT="$(env_value OFFSITE_CERT)"
[ -n "$CERT" ] || { echo "ОШИБКА: OFFSITE_CERT не задан в .env"; exit 1; }
[ -s "$CERT" ] || { echo "ОШИБКА: открытый ключ $CERT не найден"; exit 1; }
[ -d "$SRC" ] || { echo "ОШИБКА: каталог копии $SRC не найден"; exit 1; }

OUT_DIR="$HOME/backups-pc"
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"
OUT="$OUT_DIR/$(basename "$SRC").cms"
chmod 600 "$OUT" 2>/dev/null || true

# Шифрование потоком: незашифрованный архив на диск не пишется.
tar czf - -C "$(dirname "$SRC")" "$(basename "$SRC")" \
  | openssl cms -encrypt -binary -aes256 -outform DER "$CERT" > "$OUT"
chmod 600 "$OUT"

SIZE="$(stat -c %s "$OUT")"
[ "$SIZE" -gt 1024 ] || { echo "ОШИБКА: шифровка подозрительно мала ($SIZE байт)"; exit 1; }
openssl cms -cmsout -inform DER -in "$OUT" -noout 2>/dev/null \
  || { echo "ОШИБКА: файл не читается как CMS-конверт"; exit 1; }

# Отметка для самопроверки сервиса: та же state/backup-offsite-ok, что писал
# backup-offsite.sh — алерт «копия вне сервера» теперь отражает копии на ПК.
PROJECT="${COMPOSE_PROJECT_NAME:-$(basename "$(pwd)" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')}"
docker run --rm -v "${PROJECT}_app_data:/v" alpine:3 \
  sh -c "mkdir -p /v/state && date -u +%Y-%m-%dT%H:%M:%SZ > /v/state/backup-offsite-ok" \
  || echo "ВНИМАНИЕ: отметка о копии вне сервера не записана (код $?)"

echo "READY: $OUT"
echo "SIZE: $SIZE"
echo "ГОТОВО: $OUT (для человека)"
