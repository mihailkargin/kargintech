#!/usr/bin/env bash
# Проверка, что портал закупок доступен ИЗНУТРИ контейнера app.
#
#     bash deploy/check-portal.sh
#
# Портал читает app, а не n8n: у n8n задан зарубежный прокси для Telegram.
# Поэтому проверка из n8n проверяла бы не тот сетевой путь. Здесь намеренно
# проверяются настоящий контейнер, настоящий HTTPS и настоящий разбор ответа.
# TLS-проверку не отключаем. Команда делает два запроса к настоящему ЕИС.

set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  OK   %s\n' "$*"; }
bad() { printf '  СБОЙ %s\n' "$*"; exit 1; }

say "1. Контейнер app запущен?"
docker compose ps app --format '{{.State}}' | grep -q running \
  || bad "контейнер app не запущен — сначала docker compose up -d"
ok "запущен"

say "2. Сертификаты НУЦ загружены без предупреждений?"
CERTS=$(docker compose exec -T app node -e 'process.stdout.write("проверено")' 2>&1 || true)
if grep -q 'Ignoring extra certs\|load failed' <<<"$CERTS"; then
  bad "Node отвергает файл сертификатов: $CERTS"
fi
ok "предупреждений о сертификатах нет"

say "3. NODE_EXTRA_CA_CERTS указывает на читаемый набор?"
PATHOK=$(docker compose exec -T app node -e '
  const fs = require("fs");
  const p = process.env.NODE_EXTRA_CA_CERTS;
  if (!p) process.stdout.write("НЕТ:переменная не задана");
  else if (!fs.existsSync(p)) process.stdout.write("НЕТ:файла нет");
  else {
    const n = (fs.readFileSync(p, "utf8").match(/BEGIN CERTIFICATE/g) || []).length;
    process.stdout.write(n >= 2 ? "ДА" : "НЕТ:в файле меньше двух сертификатов");
  }
' 2>/dev/null || echo "НЕТ:не удалось проверить")
[[ "$PATHOK" == "ДА" ]] || bad "$PATHOK"
ok "системный набор сертификатов читается"

say "4. У app не задан глобальный зарубежный прокси?"
PROXY=$(docker compose exec -T app node -e '
  process.stdout.write(process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy ? "ДА" : "НЕТ")
')
[[ "$PROXY" == "НЕТ" ]] || bad "у app задан HTTP_PROXY/HTTPS_PROXY: ЕИС увидит зарубежный адрес"
ok "запросы к ЕИС идут напрямую"

say "5. Портал отвечает из app с проверкой сертификата"
RESULT=$(docker compose exec -T app node -e '
  fetch("https://zakupki.gov.ru/epz/main/public/home.html", {
    redirect: "follow",
    headers: { "User-Agent": "KarginTech/1.0 (+https://kargintech.ru)" }
  })
    .then((r) => process.stdout.write("КОД:" + r.status))
    .catch((e) => process.stdout.write("ОШИБКА:" + (e.cause ? e.cause.code || e.cause.message : e.message)));
' 2>/dev/null || echo "ОШИБКА:не удалось выполнить запрос")

case "$RESULT" in
  КОД:200) ok "портал ответил кодом 200, сертификат НУЦ принят" ;;
  КОД:*)   bad "портал ответил кодом ${RESULT#КОД:}" ;;
  *certificate*|*CERT*|*SELF_SIGNED*|*UNABLE_TO*)
           bad "сертификат не принят: ${RESULT#ОШИБКА:}" ;;
  *)       bad "запрос не прошёл: ${RESULT#ОШИБКА:}" ;;
esac

# Два запроса проверки тоже подчиняются бережному темпу обращений к ЕИС.
sleep 2
say "6. Ответ портала разбирается нашим парсером"
PARSE=$(docker compose exec -T app node -e '
  fetch("https://zakupki.gov.ru/epz/order/extendedsearch/results.html?searchString=%D0%B1%D1%83%D0%BC%D0%B0%D0%B3%D0%B0&fz44=on&pageNumber=1", {
    headers: { "User-Agent": "KarginTech/1.0 (+https://kargintech.ru)" }
  })
    .then((r) => r.text())
    .then((html) => {
      const { parseSearchPage } = require("/opt/tender/src/parser.js");
      const tenders = parseSearchPage(html);
      process.stdout.write(Array.isArray(tenders) && tenders.length > 0
        ? "ДА:" + tenders.length
        : "НЕТ:страница получена, но карточек не разобрано — разметка портала могла измениться");
    })
    .catch((e) => process.stdout.write("НЕТ:" + e.message));
' 2>/dev/null || echo "НЕТ:не удалось выполнить разбор")

case "$PARSE" in
  ДА:*) ok "разобрано карточек: ${PARSE#ДА:}" ;;
  *)    bad "${PARSE#НЕТ:}" ;;
esac

say "Портал доступен из app и разбирается. Это главное звено сервиса."
