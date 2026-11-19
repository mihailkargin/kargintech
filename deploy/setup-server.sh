#!/usr/bin/env bash
# Подготовка чистого сервера Ubuntu 22.04/24.04 под запуск сервиса.
#
# Запускать ОДИН РАЗ на новом сервере, от пользователя с правами sudo:
#     bash deploy/setup-server.sh
#
# Что делает: ставит Docker, закрывает лишние порты, включает автообновления
# безопасности, проверяет доступ к порталу закупок. Сам сервис не запускает —
# для этого сначала нужно заполнить .env.

set -euo pipefail

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  OK   %s\n' "$*"; }
bad() { printf '  СБОЙ %s\n' "$*"; }

if [[ $EUID -eq 0 ]]; then
  bad "Запускать не от root, а от обычного пользователя с sudo."
  exit 1
fi

say "1. Проверка, что сервер российский"
# Портал закупок не отвечает на зарубежные адреса вообще — не «медленно»,
# а соединение не устанавливается. Ошибиться со страной сервера означает
# обнаружить это только после установки всего остального.
COUNTRY=$(curl -s --max-time 15 http://ip-api.com/line/?fields=countryCode || echo '??')
IP=$(curl -s --max-time 15 https://api.ipify.org || echo '?')
echo "  IP: $IP, страна: $COUNTRY"
if [[ "$COUNTRY" != "RU" ]]; then
  bad "Сервер не в России. Портал закупок с него не откроется."
  bad "Это основной сервер — он должен быть российским. Проверь, тот ли сервер."
  exit 1
fi
ok "сервер российский"

say "2. Обновление системы и базовые пакеты"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -yqq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -yqq \
  ca-certificates curl gnupg ufw unattended-upgrades openssl
ok "пакеты установлены"

say "3. Корневые сертификаты НУЦ Минцифры"
# Нужны и на самом сервере, и внутри контейнера. Скачиваем ОДИН раз сюда,
# проверяем, и дальше образ берёт файлы отсюда же — чтобы сборка не зависела
# от доступности стороннего сайта и чтобы сертификат можно было посмотреть
# глазами до того, как он попадёт в доверенные.
#
# ВНИМАНИЕ: адреса взяты с официального сайта Госуслуг, но не проверялись
# на момент написания скрипта. Если скачивание не удалось — найти актуальные
# ссылки на https://www.gosuslugi.ru/crt и подставить вручную.
CERT_DIR="$(cd "$(dirname "$0")" && pwd)/certs"
mkdir -p "$CERT_DIR"

fetch_cert() {
  local url="$1" out="$2"
  if ! curl -fsSL --max-time 60 -o "$out" "$url"; then
    bad "не скачался сертификат: $url"
    bad "взять актуальную ссылку на https://www.gosuslugi.ru/crt и положить файл в $CERT_DIR"
    exit 1
  fi
  # Проверяем, что это действительно сертификат, а не страница с ошибкой.
  if ! openssl x509 -in "$out" -noout -subject >/dev/null 2>&1; then
    bad "скачался не сертификат, а что-то другое: $out"
    exit 1
  fi
  echo "    $(openssl x509 -in "$out" -noout -subject)"
}

fetch_cert https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt \
           "$CERT_DIR/russian_trusted_root_ca.crt"
fetch_cert https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt \
           "$CERT_DIR/russian_trusted_sub_ca.crt"

sudo cp "$CERT_DIR"/russian_trusted_*.crt /usr/local/share/ca-certificates/
sudo update-ca-certificates >/dev/null
ok "сертификаты скачаны, проверены и установлены в систему"

# Отдельный склеенный файл для контейнеров. Внутри образа n8n утилиты
# update-ca-certificates нет: с 01.10.2026 n8n собран как Docker Hardened
# Image, менеджер пакетов и часть утилит оттуда вырезаны. Поэтому сертификаты
# подставляются Node через NODE_EXTRA_CA_CERTS, а эта переменная принимает
# ровно один файл — значит склеивать надо здесь.
#
# СКЛЕИВАЕМ ЧЕРЕЗ OPENSSL, А НЕ ЧЕРЕЗ cat. Простое объединение файлов
# 01.10.2026 дало файл, который Node молча отверг:
#     Warning: Ignoring extra certs ... PEM routines::bad end line
# Слово Ignoring здесь означает, что сертификаты НЕ загружены: сервис
# при этом поднимается нормально, и ломается только обращение к порталу —
# то есть ровно то, за чем всё это и делается. Причина в окончаниях строк:
# если первый файл не кончается переводом строки, END и BEGIN склеиваются
# в одну строку, и разбор PEM обрывается.
#
# openssl x509 переписывает каждый сертификат в заведомо правильном виде,
# и этот класс ошибок исчезает целиком, а не лечится по одному случаю.
: > "$CERT_DIR/russian-ca-bundle.crt"
for f in "$CERT_DIR/russian_trusted_root_ca.crt" "$CERT_DIR/russian_trusted_sub_ca.crt"; do
  openssl x509 -in "$f" -outform PEM >> "$CERT_DIR/russian-ca-bundle.crt"
done

# Проверяем не подсчётом строк, а разбором: файл с двумя блоками текста
# может всё равно не читаться. Разбирает его тот же OpenSSL, который
# разбирает его и в бою.
BUNDLE_COUNT=$(openssl crl2pkcs7 -nocrl -certfile "$CERT_DIR/russian-ca-bundle.crt" 2>/dev/null \
  | openssl pkcs7 -print_certs -noout 2>/dev/null | grep -c 'subject=' || true)
if [[ "$BUNDLE_COUNT" -ne 2 ]]; then
  bad "в склеенном файле разбирается $BUNDLE_COUNT сертификатов вместо 2"
  bad "образ n8n с таким файлом поднимется, но портал из него будет недоступен"
  exit 1
fi
ok "склеенный файл для контейнеров готов: 2 сертификата, оба разбираются"

say "4. Проверка доступа к порталу закупок"
# Проверяем именно с проверкой сертификата. Если тут падает — значит
# сертификаты не встали, и это надо чинить сейчас, а не в бою.
if curl -fsS --max-time 30 -A 'KarginTech/1.0 (+https://kargintech.ru)' -o /dev/null -w '  код ответа: %{http_code}\n' \
    https://zakupki.gov.ru/epz/main/public/home.html; then
  ok "портал отвечает, сертификат принят"
else
  bad "портал недоступен или сертификат не принят — дальше идти нет смысла"
  exit 1
fi

say "5. Docker"
if ! command -v docker >/dev/null; then
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -yqq \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"
  ok "Docker установлен (понадобится перезайти в систему)"
else
  ok "Docker уже стоит"
fi

say "6. Сетевой экран"
# Открыты только те порты, которые нужны: вход по SSH и веб.
# Панель n8n наружу напрямую не смотрит — её отдаёт Caddy по HTTPS.
# Без `ufw reset` (правило проекта): правила добавляются к существующим,
# на чистом сервере результат тот же, а на настроенном ничего не теряется.
sudo ufw default deny incoming >/dev/null
sudo ufw default allow outgoing >/dev/null
sudo ufw allow OpenSSH >/dev/null
sudo ufw allow 80/tcp >/dev/null
sudo ufw allow 443/tcp >/dev/null
sudo ufw --force enable >/dev/null
ok "открыты только SSH, 80 и 443"

say "7. Автоматические обновления безопасности"
echo 'Unattended-Upgrade::Automatic-Reboot "false";' \
  | sudo tee /etc/apt/apt.conf.d/51-no-auto-reboot >/dev/null
sudo systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
ok "включены"

say "Готово. Что дальше:"
cat <<'NEXT'
  1. Выйти и зайти снова по SSH — иначе docker будет требовать sudo.
  2. cp deploy/.env.example deploy/.env
  3. Заполнить .env. Пароль и ключ сгенерировать: openssl rand -base64 32
     Ключ шифрования сохранить в менеджере паролей СРАЗУ.
  4. Убедиться, что домен из N8N_HOST указывает на IP этого сервера.
  5. cd deploy && docker compose up -d --build
  6. Открыть https://ваш-домен и создать учётную запись владельца.
  7. Проверить конвертер: bash deploy/check-converter.sh
NEXT
