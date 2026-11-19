# Конвертер старых форматов Microsoft: .doc -> .docx, .xls -> .xlsx, .rtf -> .docx
#
# Отдельный контейнер, а не слой внутри n8n. Причина не вкусовая: с 01.10.2026
# образ n8n собран как Docker Hardened Image, и менеджер пакетов оттуда вырезан
# намеренно — установить LibreOffice внутрь невозможно (проверено на сервере,
# apk add упал с кодом 127). Подробности — в deploy/Dockerfile.
#
# Выгода от разделения, помимо вынужденности: LibreOffice — тяжёлая программа,
# которая умеет зависать. В своём контейнере его зависание не трогает n8n,
# а docker перезапустит именно его.
#
# Основа — Debian, а не Alpine: в Debian LibreOffice лежит в обычном
# репозитории, а не в экспериментальном. Образ получается крупнее (около 1 ГБ),
# но предсказуемее — а для разового пересохранения файла размер образа
# значит меньше, чем вероятность, что он соберётся и завтра.

FROM debian:12-slim

# libreoffice-writer и libreoffice-calc — без остального пакета: нужны только
# doc -> docx и xls -> xlsx. Полный LibreOffice тянет презентации, рисование,
# базу данных и Java — лишние сотни мегабайт.
#
# Шрифты обязательны: без них LibreOffice пересохраняет документ с пустыми
# страницами — формально успех, фактически потеря всего текста.
# fonts-dejavu и fonts-liberation покрывают кириллицу и метрики Microsoft.
#
# --no-install-recommends отсекает Java и словари: для пересохранения
# форматов они не нужны.
#
# poppler-utils — ради одной программы, pdftotext: она достаёт текст из PDF
# с текстовым слоем, сохраняя колонки таблиц. Решение владельца 14.10.2026:
# «тз должен читать код, а не модель, только если она в картинке». До этого
# PDF с ТЗ переписывала модель — $0,37 на одну закупку, и характеристики
# всё равно нашлись лишь для 17 позиций из 55.
#
# Почему здесь, а не в образе приложения: этот контейнер видит только файлы
# с портала, прайсов клиентов в нём нет. Сторонняя программа запирается
# в отсек, где нет данных клиента, — то же правило, что для LibreOffice.
#
# tesseract-ocr с русским языком — распознавание сканов и фотографий кодом.
# Решение владельца 16.10.2026: «если фото — делаем блок, который может это
# осуществить», модель только для поиска в открытых источниках. Tesseract —
# тот же движок, который оборачивают библиотеки Python (pytesseract);
# вызываем его напрямую, без Python-обёртки, — меньше чужого кода в отсеке.
# libarchive-tools — ради bsdtar: распаковка RAR и 7z (20.10.2026), основной
# репозиторий Debian, без несвободных пакетов.
#
# Пакеты — с mirror.yandex.ru: 19.10.2026 сервер 12 минут не мог подключиться
# к deb.debian.org (так же собирается сервис таблиц).
# apt-get upgrade - обновления безопасности основы (Trivy 22.10.2026: perl, expat).
RUN sed -i 's#http://deb.debian.org#http://mirror.yandex.ru#g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
        libarchive-tools \
        libreoffice-writer \
        libreoffice-calc \
        poppler-utils \
        tesseract-ocr \
        tesseract-ocr-rus \
        tesseract-ocr-osd \
        fonts-dejavu \
        fonts-liberation \
        nodejs \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

# unar - RAR «solid», который bsdtar не читает (25.10.2026). Отдельным слоем,
# чтобы не пересобирать слой с LibreOffice; основной репозиторий Debian.
RUN sed -i 's#http://deb.debian.org#http://mirror.yandex.ru#g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends unar \
    && rm -rf /var/lib/apt/lists/*

# Работаем не от root: контейнер принимает файлы извне, и давать им
# полномочия root незачем. LibreOffice пишет только в свой профиль в /tmp.
RUN useradd --create-home --shell /usr/sbin/nologin conv

# Модули логики. Сервису нужен ровно один — extract-text.js, откуда берётся
# conversionCommand(). Команда запуска LibreOffice держится в одном месте
# на весь проект: иначе правка профиля запуска в одном файле и забытая
# в другом дадут два разных поведения, и разницу заметит только клиент.
COPY --chown=conv:conv src/ /opt/tender/
COPY --chown=conv:conv deploy/converter/server.js /opt/converter/server.js

USER conv
WORKDIR /opt/converter

ENV PORT=3000
EXPOSE 3000

# Проверка живости спрашивает у самого LibreOffice его версию. Просто
# «порт отвечает» здесь мало: сервис может подняться, а конвертер — нет,
# и тогда отказ будет тихим.
HEALTHCHECK --interval=60s --timeout=40s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "/opt/converter/server.js"]
