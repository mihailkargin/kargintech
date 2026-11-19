#!/bin/bash
# ПРОБНОЕ ВОССТАНОВЛЕНИЕ РЕЗЕРВНОЙ КОПИИ — 21.10.2026.
#
#   cd ~/kargintech/deploy && bash ./restore-test.sh [каталог копии]
#
# Восстанавливает последнюю (или указанную) копию во ВРЕМЕННЫЕ контейнеры и
# проверяет, что из неё действительно поднимается то, что нужно:
#   — база n8n заливается в отдельный Postgres и считаются таблицы;
#   — тома распаковываются внутри контейнера и проверяются ключевые файлы;
#   — база сайта открывается и считаются пользователи.
#
# РАБОЧУЮ СИСТЕМУ НЕ ТРОГАЕТ: ни томов, ни базы, ни .env. Временные контейнеры
# запускаются с --rm и исчезают сами; на диске сервера ничего не создаётся.
# Копия, которую не пробовали восстановить, — не копия (AGENTS.md).
set -euo pipefail
cd "$(dirname "$0")"

BACKUP_ROOT="${BACKUP_ROOT:-$HOME/backups}"
DEST="${1:-$(ls -1d "$BACKUP_ROOT"/20*_* 2>/dev/null | sort | tail -n 1)}"
[ -d "$DEST" ] || { echo "ОШИБКА: копии нет ($DEST)"; exit 1; }
echo "=== ПРОБНОЕ ВОССТАНОВЛЕНИЕ: $DEST ==="

env_value() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$DEST/env" | head -n 1 | tr -d '\r' \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}
DB_USER="$(env_value DB_USER)"
DB_NAME="$(env_value DB_NAME)"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] || { echo "ОШИБКА: в копии .env нет DB_USER/DB_NAME"; exit 1; }
grep -q 'N8N_ENCRYPTION_KEY=.\+' "$DEST/env" && echo "ключ шифрования n8n в копии есть" || echo "ВНИМАНИЕ: ключа шифрования n8n в копии нет"

# --- база n8n ---------------------------------------------------------------
NAME="kt-restore-test-$$"
PASS="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD="$PASS" -e POSTGRES_USER="$DB_USER" -e POSTGRES_DB="$DB_NAME" postgres:16-alpine >/dev/null
trap 'docker stop "$NAME" >/dev/null 2>&1 || true' EXIT
for i in $(seq 1 30); do docker exec "$NAME" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1 && break; sleep 2; done
docker exec -i "$NAME" psql -q -U "$DB_USER" -d "$DB_NAME" < "$DEST/n8n-db.sql" > /dev/null 2>&1 || true
EXPECT=$(grep -c 'CREATE TABLE' "$DEST/n8n-db.sql" || true)
GOT=$(docker exec "$NAME" psql -tA -U "$DB_USER" -d "$DB_NAME" -c "select count(*) from information_schema.tables where table_schema='public'")
WF=$(docker exec "$NAME" psql -tA -U "$DB_USER" -d "$DB_NAME" -c "select count(*) from workflow_entity" 2>/dev/null || echo "?")
echo "база n8n: таблиц в dump $EXPECT, восстановлено $GOT, воркфлоу $WF"
[ "$GOT" = "$EXPECT" ] || { echo "ОШИБКА: восстановлены не все таблицы"; exit 1; }

# --- тома -------------------------------------------------------------------
for vol in n8n_data app_data site_data; do
  [ -f "$DEST/$vol.tgz" ] || { echo "-- $vol: архива нет${vol:+ (нормально, если сайт ещё не был развёрнут)}"; continue; }
  docker run --rm -v "$DEST:/b:ro" alpine:3 sh -c "mkdir /r && tar xzf /b/$vol.tgz -C /r && echo \"-- $vol: файлов \$(find /r -type f | wc -l)\""
done
docker run --rm -v "$DEST:/b:ro" alpine:3 sh -c 'mkdir /r && tar xzf /b/app_data.tgz -C /r && echo "   настроек клиентов: $(ls /r/clients/*.json 2>/dev/null | wc -l), файлов состояния: $(ls /r/state 2>/dev/null | wc -l)"'
if [ -f "$DEST/site_data.tgz" ]; then
  docker run --rm -v "$DEST:/b:ro" node:22-slim sh -c "mkdir /r && tar xzf /b/site_data.tgz -C /r && node --disable-warning=ExperimentalWarning -e \"const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/r/site-snapshot.db',{readOnly:true});console.log('   база сайта из снимка: пользователей',d.prepare('select count(*) n from users').get().n,', компаний',d.prepare('select count(*) n from companies').get().n,', расчётов',d.prepare('select count(*) n from calcs').get().n)\""
fi
# --- приложение и сайт из копии (25.10.2026) ------------------------------------
# Настоящие образы стартуют во ВРЕМЕННЫХ контейнерах (--rm) на данных из копии:
# том распаковывается внутрь самого контейнера, рабочие тома не подключаются.
# Поток к порталу выключен (STREAM=off), запросы - только к самому себе.
if docker image inspect deploy-app:latest >/dev/null 2>&1; then
  # --user 0: архивы копии с правами 600, образ работает не от root - без этого
  # распаковка падала, а приложение поднималось на ПУСТЫХ данных и проверка
  # «проходила» (25.10.2026). Теперь сбой распаковки - сбой проверки.
  docker run --rm --user 0 -v "$DEST:/b:ro" -e STREAM=off -e STATE_DIR=/data/state -e CLIENTS_DIR=/data/clients \
    --entrypoint sh deploy-app:latest -c '
      set -e
      mkdir -p /data && tar xzf /b/app_data.tgz -C /data
      node /opt/tender/app/server.js > /tmp/app.log 2>&1 &
      sleep 6
      node -e "
        const п = (u, т) => fetch(\"http://127.0.0.1:3100\" + u, т ? { method: \"POST\", headers: { \"Content-Type\": \"application/json\" }, body: JSON.stringify(т) } : {}).then((r) => r.json());
        (async () => {
          const з = await п(\"/health\");
          const кл = require(\"fs\").readdirSync(\"/data/clients\").filter((ф) => /^site-.*\\.json$/.test(ф)).map((ф) => ф.slice(0, -5));
          const л = кл.length ? await п(\"/tenders\", { клиент: кл[0] }) : { тендеры: [] };
          const а = await п(\"/archive-stats\");
          console.log(\"   приложение из копии: health\", з.ok ? \"ok\" : \"СБОЙ\", \"| лента\", кл[0] || \"-\", (л.тендеры || []).length, \"тендеров | архив\", JSON.stringify(а).slice(0, 160));
          // Успех - только на НЕпустых данных: клиенты сайта есть, лента первого не пуста, в архиве закупки.
          process.exit(з.ok && кл.length > 0 && (л.тендеры || []).length > 0 && а.закупок > 0 ? 0 : 1);
        })().catch((e) => { console.log(\"   СБОЙ приложения из копии:\", e.message); process.exit(1); });
      "' || { echo "ОШИБКА: приложение из копии не поднялось"; exit 1; }
fi
if [ -f "$DEST/site_data.tgz" ] && docker image inspect deploy-site:latest >/dev/null 2>&1; then
  docker run --rm --user 0 -v "$DEST:/b:ro" -e SITE_DB=/data/site.db -e APP_URL=http://127.0.0.1:1 \
    --entrypoint sh deploy-site:latest -c '
      set -e
      mkdir -p /data && tar xzf /b/site_data.tgz -C /data && cp /data/site-snapshot.db /data/site.db && rm -f /data/site.db-wal /data/site.db-shm
      node --disable-warning=ExperimentalWarning /opt/tender/site/server.js > /tmp/site.log 2>&1 &
      sleep 5
      node --disable-warning=ExperimentalWarning -e "const {DatabaseSync}=require(\"node:sqlite\");const d=new DatabaseSync(\"/data/site.db\",{readOnly:true});const n=d.prepare(\"select count(*) n from users\").get().n;fetch(\"http://127.0.0.1:3200/health\").then((r) => { console.log(\"   сайт из копии: health\", r.status, \"| пользователей\", n); process.exit(r.status === 200 && n > 0 ? 0 : 1); }).catch((e) => { console.log(\"   СБОЙ сайта из копии:\", e.message); process.exit(1); })"' \
    || { echo "ОШИБКА: сайт из копии не поднялся"; exit 1; }
fi
echo "=== ВОССТАНОВЛЕНИЕ ПРОШЛО: копия поднимается ==="
