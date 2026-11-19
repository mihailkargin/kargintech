# Распознавание таблиц со сканов: OpenCV находит линии и ячейки, Tesseract
# читает каждую ячейку. Подробности — в начале server.py.
#
# Отдельный контейнер, а не слой конвертера: здесь Python и сторонние
# библиотеки (OpenCV, NumPy). Данных клиента сервис не видит — только файлы
# с портала, — поэтому чужой код заперт там, где ему нечего украсть.
#
# СБОРКА БЕЗ ЗАРУБЕЖНЫХ ХРАНИЛИЩ — найдено 19.10.2026 на сервере: первая
# сборка 12 минут не могла подключиться к deb.debian.org («Unable to connect
# to deb.debian.org:http»), позавчера тот же адрес отвечал. Поэтому:
#   - пакеты Debian — с зеркала Яндекса, содержимое то же;
#   - OpenCV и NumPy — пакетами Debian, а не через pip: pypi.org не нужен
#     вовсе. Версия OpenCV в Debian 12 — 4.6, всё нужное в ней есть.
# Основа — тот же debian:12-slim, что у конвертера: он уже лежит на сервере.
FROM debian:12-slim

RUN sed -i 's|http://deb.debian.org|http://mirror.yandex.ru|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        python3-opencv \
        python3-numpy \
        tesseract-ocr \
        tesseract-ocr-rus \
        tesseract-ocr-osd \
        poppler-utils \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /usr/sbin/nologin tables
COPY --chown=tables:tables deploy/tables/server.py deploy/tables/borderless.py /opt/tables/
USER tables
WORKDIR /opt/tables

ENV PORT=3001
EXPOSE 3001

HEALTHCHECK --interval=60s --timeout=20s --start-period=20s --retries=3 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:3001/health',timeout=15).status==200 else 1)"

CMD ["python3", "/opt/tables/server.py"]
