#!/usr/bin/env bash
#
# ПРИЁМ КОПИИ НА ЗАПАСНОМ СЕРВЕРЕ. Единственная команда, которую может
# выполнить ключ основного сервера (authorized_keys: command=...,restrict).
# Принимает шифровку из stdin, кладёт под датой, печатает размер. Хранит
# последние KEEP копий; старые удаляет сам запасной сервер, основной на это
# права не имеет.
#
# Защита от захваченного основного сервера (04.11.2026): он может слать
# мусор, чтобы вытеснить хорошие копии. Поэтому
#   - не CMS-конверт или меньше 1 КБ - не принимается;
#   - первая копия каждой недели ещё и откладывается в weekly/ на WEEKS недель.
#     Поток мусора вытесняет только ежедневные, отложенные прошлых недель
#     остаются: основной сервер их не видит и удалить не может.
set -euo pipefail
DIR="$HOME/incoming"
WEEKLY="$HOME/weekly"
KEEP=30
WEEKS=12
mkdir -p "$DIR" "$WEEKLY"
chmod 700 "$DIR" "$WEEKLY"

# Место: меньше 3 ГБ свободно - не принимаем, чтобы не забить диск целиком.
FREE_KB="$(df -Pk "$DIR" | awk 'NR==2 {print $4}')"
if [ "${FREE_KB:-0}" -lt 3145728 ]; then
  echo "мало места: ${FREE_KB} КБ" >&2
  exit 1
fi

F="$DIR/$(date -u +%Y-%m-%d_%H%M%S).cms"
# Предел 2 ГБ: шифровка больше - не копия, а ошибка или попытка забить диск.
head -c 2147483648 > "$F.part"
SIZE="$(stat -c %s "$F.part")"
# DER-конверт CMS начинается с байта 0x30 (SEQUENCE).
FIRST="$(head -c 1 "$F.part" | od -An -tx1 | tr -d ' \n')"
if [ "$SIZE" -lt 1024 ] || [ "$FIRST" != "30" ]; then
  rm -f "$F.part"
  echo "не копия: $SIZE байт, начало ${FIRST:-пусто}" >&2
  exit 1
fi
mv "$F.part" "$F"
chmod 600 "$F"

W="$WEEKLY/$(date -u +%G-W%V).cms"
[ -e "$W" ] || ln "$F" "$W"

echo "$SIZE"
{ ls -1t "$DIR"/*.cms 2>/dev/null || true; } | tail -n +$((KEEP + 1)) | xargs -r rm -f
{ ls -1t "$WEEKLY"/*.cms 2>/dev/null || true; } | tail -n +$((WEEKS + 1)) | xargs -r rm -f
