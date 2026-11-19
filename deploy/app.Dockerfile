# Приложение: вся логика проекта, вызывается из n8n по сети.
#
# ПОЧЕМУ ОТДЕЛЬНЫЙ КОНТЕЙНЕР. Решено 03.10.2026. Логика жила в Code-нодах n8n
# и обошлась в пять находок подряд, каждая из которых обнаруживалась только
# запуском на сервере: в песочнице нод нет fetch, нет AbortController,
# нет process, не действует NODE_EXTRA_CA_CERTS. Плюс код не попадал ни
# в тесты, ни в резервные копии, и каждая правка требовала ручного импорта
# файла через браузер.
#
# Теперь логика — обычное приложение: проверяется локально целиком, лежит
# в файлах проекта, покрыто теми же 878 проверками. n8n остаётся пультом:
# расписание, журнал прогонов, настройки клиентов, ручной запуск и отправка
# в Telegram.
#
# Тот же приём уже работает с конвертером старых форматов.

FROM node:22-slim

# Корневые сертификаты НУЦ Минцифры. Сертификат портала закупок выпущен
# «Russian Trusted Sub CA»; без него любой запрос падает с UntrustedRoot.
#
# Здесь, в отличие от образа n8n, работает обычный путь: файлы кладутся
# в системное хранилище и регистрируются update-ca-certificates. Образ n8n
# собран как Docker Hardened Image, и этой утилиты там нет — отсюда вся
# возня с NODE_EXTRA_CA_CERTS в том контейнере.
COPY deploy/certs/russian_trusted_root_ca.crt deploy/certs/russian_trusted_sub_ca.crt \
     /usr/local/share/ca-certificates/
# Обновления безопасности Debian и без npm - проверка Trivy 22.10.2026 нашла
# устаревший perl в основе и дыры в пакетах самого npm. npm в работе не нужен:
# внешних зависимостей у проекта нет. Пакеты - с зеркала Яндекса
# (deb.debian.org 19.10.2026 не отвечал серверу).
RUN sed -i 's|http://deb.debian.org|http://mirror.yandex.ru|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

# Node берёт доверенные корни не из системного хранилища, а из своего набора.
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

WORKDIR /opt/tender

# Сначала логика, потом оркестраторы — так при правке склейки не пересобирается
# слой с модулями.
COPY src/ ./src/
COPY app/ ./app/
COPY package.json ./

# Внешних зависимостей у проекта нет — ни одной. Поэтому npm install не нужен,
# и нечему устаревать или ломаться из-за чужого обновления.
RUN useradd --create-home --shell /usr/sbin/nologin tender \
    && mkdir -p /data/state /data/clients \
    && chown -R tender:tender /opt/tender /data

USER tender

ENV PORT=3100
EXPOSE 3100

# Проверка живости отвечает и на вопрос, задан ли ключ модели: без него
# поиск поставщиков молча пропускается, а это надо видеть.
HEALTHCHECK --interval=60s --timeout=15s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3100/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "/opt/tender/app/server.js"]
