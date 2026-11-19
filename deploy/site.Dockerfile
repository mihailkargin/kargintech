# Сайт kargintech.ru — публичная часть и личный кабинет. 21.10.2026.
#
# Отдельный контейнер, а не часть приложения `app`: сайт открыт в интернет
# (через Caddy), а `app` держит прайсы клиентов и в интернет не смотрит.
# Сайт с данными приложения работает только через его внутренние точки входа.
#
# Сторонних библиотек нет: база — встроенный в Node SQLite (node:sqlite),
# пароли и коды — встроенный crypto.
FROM node:22-slim

# Обновления безопасности Debian и без npm - проверка Trivy 22.10.2026
# (устаревший perl в основе, дыры в пакетах самого npm; npm сайту не нужен).
RUN sed -i 's|http://deb.debian.org|http://mirror.yandex.ru|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

WORKDIR /opt/tender
# Из src/ сайту нужен только вывод денег (notify.js) и то, что он подключает.
COPY src/ ./src/
COPY site/ ./site/

RUN useradd --create-home --shell /usr/sbin/nologin site \
    && mkdir -p /data \
    && chown -R site:site /opt/tender /data

USER site
ENV PORT=3200 SITE_DB=/data/site.db
EXPOSE 3200

HEALTHCHECK --interval=60s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3200/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "/opt/tender/site/server.js"]
