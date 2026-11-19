#!/usr/bin/env bash
# Проверка, что конвертер старых форматов реально работает.
#
#     bash deploy/check-converter.sh
#
# Зачем отдельная проверка. Конвертер — единственная часть системы, которая
# живёт не в нашем коде, а в стороннем пакете. Если он не встал или не видит
# шрифтов, это не вызовет ошибки при запуске: n8n поднимется, воркфлоу
# заработают, и только по каждой четвёртой закупке документация молча окажется
# непрочитанной. Ловить такое в бою — худший вариант.
#
# ЧТО ИЗМЕНИЛОСЬ 01.10.2026. Раньше конвертер жил внутри контейнера n8n,
# и проверка искала там soffice. Теперь его там нет и быть не может: образ n8n
# собран как Docker Hardened Image, установить в него ничего нельзя.
# Конвертер стал отдельным сервисом, поэтому проверяются две разные вещи —
# работает ли он сам и достаёт ли до него n8n по сети. Второе важно отдельно:
# рабочий конвертер, до которого нет сети, даёт ровно тот же тихий отказ.

set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  OK   %s\n' "$*"; }
bad() { printf '  СБОЙ %s\n' "$*"; exit 1; }

say "1. Контейнеры запущены?"
for service in converter n8n app; do
  docker compose ps "$service" --format '{{.State}}' | grep -q running \
    || bad "контейнер $service не запущен — сначала docker compose up -d"
done
ok "converter, n8n и app запущены"

say "2. Конвертация от начала до конца, внутри сервиса"
# Полная проверка живёт отдельным файлом и подаётся в node через stdin:
# так её можно править, не пересобирая образ. Что именно она проверяет —
# написано в самом файле.
docker compose exec -T converter node - < converter/selftest.js \
  || bad "сквозная проверка конвертера не прошла — вывод выше"

say "3. n8n и app достают до конвертера по сети"
for service in n8n app; do
  NET=$(docker compose exec -T "$service" node -e '
    const url = (process.env.CONVERTER_URL || "") + "/health";
    if (!process.env.CONVERTER_URL) { process.stdout.write("НЕТ:CONVERTER_URL не задан"); process.exit(0); }
    fetch(url).then(async (r) => {
      const t = await r.text();
      process.stdout.write(r.ok && t.includes("\"ok\":true") ? "ДА" : "НЕТ:код " + r.status + " " + t.slice(0, 200));
    }).catch((e) => process.stdout.write("НЕТ:" + e.message));
  ') || bad "не удалось выполнить проверку внутри $service"
  [[ "$NET" == "ДА" ]] || bad "$service не достаёт до конвертера ($NET)"
  ok "$service видит конвертер по адресу из CONVERTER_URL"
done

say "Конвертер работает. Старые .doc, .xls и .rtf будут читаться."
