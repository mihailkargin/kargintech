"""
Распознавание ТАБЛИЦ со сканов — отдельный сервис на Python, 19.10.2026.

Зачем. Tesseract читает текст, но не понимает таблицу: каждую ячейку в рамке
он выдаёт отдельной строкой, и «наименование — количество — цена»
разваливаются по разным строкам. На закупке 0190200000326011772 после
исправления поворота текст стал читаемым («Наименование предмета закупки
(попозиционно) · Количество · 17.12.14.110-00000005: Формат: A4»), а позиций
всё равно ноль — разбор ищет их в одной строке.

Как. OpenCV находит на картинке линии таблицы, по ним — ячейки, каждая
ячейка распознаётся Tesseract отдельно, строки собираются обратно: ячейки
через табуляцию, строки через перевод строки. Это ровно тот вид, который
даёт чтение Word и который понимает наш разбор таблиц (src/nmck-table.js).

Модели здесь нет: решение владельца 16.10.2026 — «если фото, делаем питон
блок», модель только для поиска в открытых источниках.

Изоляция. Сервис видит только файлы с портала закупок, данных клиента в нём
нет. Сторонние библиотеки (OpenCV, NumPy) заперты в этом контейнере — то же
правило, что для LibreOffice и Tesseract в конвертере. Порт наружу не
публикуется.

Таблицы БЕЗ линий (22.10.2026): колонки находятся по пустым вертикальным
промежуткам между словами — borderless.py. Объединённые ячейки дают строку с меньшим числом ячеек. Цифры распознаются
с ошибками — приложение помечает такие позиции «сверить с документом».
"""

import json
import os
import re
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np

import borderless

ПОРТ = int(os.environ.get('PORT', '3001'))
СТРАНИЦ = int(os.environ.get('TABLES_MAX_PAGES', '20'))
ЯЧЕЕК_НА_СТРАНИЦЕ = 600
МАКС_БАЙТ = 100 * 1024 * 1024


def запустить(команда, секунд):
    return subprocess.run(команда, capture_output=True, timeout=секунд)


def вид_файла(b):
    if b[:4] == b'%PDF':
        return 'pdf'
    if b[:4] == b'\x89PNG':
        return 'png'
    if b[:3] == b'\xff\xd8\xff':
        return 'jpg'
    if b[:4] in (b'II*\x00', b'MM\x00*'):
        return 'tif'
    return ''


def доля_слов(текст):
    """Та же мера, что качествоРаспознавания в src/extract-text.js."""
    токены = [т for т in re.split(r'\s+', текст or '') if len(т) >= 2]
    if not токены:
        return 0.0
    слова = [т for т in токены
             if re.match(r'^[А-ЯЁа-яё][а-яё]{3,}[.,;:)]?$', т) and re.search(r'[аеёиоуыэюя]', т)]
    return len(слова) / len(токены)


def распознать(картинка, режим='6'):
    with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as f:
        путь = f.name
    try:
        cv2.imwrite(путь, картинка)
        р = запустить(['tesseract', путь, 'stdout', '-l', 'rus+eng', '--psm', режим], 60)
        return р.stdout.decode('utf-8', 'replace').strip()
    finally:
        os.unlink(путь)


def выпрямить(серое):
    """Повёрнутая страница: пробуем 0, 90, 180, 270 и берём ту, где больше слов.
    Направление поворота у Tesseract легко перепутать — проверяем результатом."""
    лучшее, лучшая_доля = серое, доля_слов(распознать(серое))
    if лучшая_доля >= 0.15:
        return серое
    for поворот in (cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_90_COUNTERCLOCKWISE, cv2.ROTATE_180):
        вариант = cv2.rotate(серое, поворот)
        доля = доля_слов(распознать(вариант))
        if доля > лучшая_доля:
            лучшее, лучшая_доля = вариант, доля
    return лучшее


def ячейки(серое):
    """Прямоугольники ячеек по линиям таблицы."""
    ч_б = cv2.adaptiveThreshold(~серое, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, 15, -2)
    высота, ширина = ч_б.shape
    гор = cv2.getStructuringElement(cv2.MORPH_RECT, (max(20, ширина // 30), 1))
    верт = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(20, высота // 30)))
    линии = cv2.add(cv2.dilate(cv2.erode(ч_б, гор), гор), cv2.dilate(cv2.erode(ч_б, верт), верт))
    линии = cv2.dilate(линии, np.ones((3, 3), np.uint8))
    контуры, _ = cv2.findContours(линии, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    рамки = []
    for к in контуры:
        x, y, w, h = cv2.boundingRect(к)
        if w < 15 or h < 12:
            continue
        if w > 0.95 * ширина and h > 0.95 * высота:
            continue
        рамки.append((x, y, w, h))
    # Ячейка — рамка, внутри которой нет других рамок (внешняя рамка
    # таблицы и строки целиком содержат ячейки и отбрасываются).
    def внутри(a, b):
        return a != b and a[0] >= b[0] - 2 and a[1] >= b[1] - 2 \
            and a[0] + a[2] <= b[0] + b[2] + 2 and a[1] + a[3] <= b[1] + b[3] + 2
    return [b for b in рамки if not any(внутри(a, b) for a in рамки)]


def в_строки(список):
    """Ячейки по строкам: одна строка — центры по высоте в пределах половины ячейки."""
    строки = []
    for я in sorted(список, key=lambda r: (r[1], r[0])):
        центр = я[1] + я[3] / 2
        for с in строки:
            if abs(с['центр'] - центр) < min(с['h'], я[3]) / 2:
                с['ячейки'].append(я)
                break
        else:
            строки.append({'центр': центр, 'h': я[3], 'ячейки': [я]})
    return [sorted(с['ячейки'], key=lambda r: r[0]) for с in строки]


def без_линий(серое):
    """Линий таблицы нет - колонки по пустым промежуткам между словами
    (borderless.py, 22.10.2026). Tesseract отдаёт слова с координатами."""
    with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as f:
        путь = f.name
    try:
        cv2.imwrite(путь, серое)
        р = запустить(['tesseract', путь, 'stdout', '-l', 'rus+eng', '--psm', '6',
                       '-c', 'preserve_interword_spaces=1', 'tsv'], 120)
    finally:
        os.unlink(путь)
    текст = borderless.собрать(borderless.слова_из_tsv(р.stdout.decode('utf-8', 'replace')))
    if not текст:
        return None, 0
    return текст, sum(1 for с in текст.split('\n') if '\t' in с)


def страница(путь):
    серое = cv2.imread(путь, cv2.IMREAD_GRAYSCALE)
    if серое is None:
        return None, 0
    серое = выпрямить(серое)
    найдено = ячейки(серое)
    if len(найдено) < 6:
        return без_линий(серое)
    найдено = найдено[:ЯЧЕЕК_НА_СТРАНИЦЕ]
    строки = в_строки(найдено)
    # КОЛОНКИ — ПО КООРДИНАТАМ, а не по порядку ячеек (19.10.2026). В строке
    # с объединённой ячейкой (наименование вместе с кодом КТРУ) ячеек на одну
    # меньше, и при счёте по порядку всё съезжало влево: наименованием
    # становился код, единицей — цена. Теперь каждая ячейка ставится под ту
    # колонку шапки, над серединой которой она стоит; объединённая ячейка —
    # под первую из накрытых колонок, остальные остаются пустыми.
    шапка = max(строки, key=len) if строки else []
    колонки = [(x, x + w) for x, y, w, h in шапка]

    def по_колонкам(строка):
        if not колонки or len(строка) == len(колонки):
            return строка, list(range(len(строка)))
        места = []
        for x, y, w, h in строка:
            накрытые = [i for i, (л, п) in enumerate(колонки) if x - 5 <= (л + п) / 2 <= x + w + 5]
            if not накрытые:
                накрытые = [min(range(len(колонки)), key=lambda i: abs((колонки[i][0] + колонки[i][1]) / 2 - (x + w / 2)))]
            места.append(накрытые[0])
        return строка, места

    вывод = []
    for строка in строки:
        строка, места = по_колонкам(строка)
        тексты = [''] * max(len(колонки), (max(места) + 1) if места else 0)
        for (x, y, w, h), место in zip(строка, места):
            кусок = серое[y + 3:y + h - 3, x + 3:x + w - 3]
            # ПУСТАЯ ЯЧЕЙКА — по числу тёмных точек, а не по средней яркости.
            # 19.10.2026, закупка 0190200000326011772: ячейка с коротким числом
            # («50», «312,50») почти вся белая, средняя яркость выше 250 — и все
            # количества и цены выбрасывались как пустые. Таблица собиралась,
            # а чисел в ней не было.
            if кусок.size == 0 or int((кусок < 128).sum()) < 12:
                continue
            # Ячейка в одну строку — режим «одна строка» и увеличение вдвое:
            # мелкие цифры Tesseract читает надёжнее крупными. Белая рамка
            # вокруг — без неё символы у края теряются.
            рамка = cv2.copyMakeBorder(кусок, 10, 10, 10, 10, cv2.BORDER_CONSTANT, value=255)
            if h < 70:
                рамка = cv2.resize(рамка, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
                текст = распознать(рамка, '7')
            else:
                текст = распознать(рамка, '6')
            # Две ячейки под одной колонкой (перенос внутри ячейки) склеиваются.
            тексты[место] = (тексты[место] + ' ' + re.sub(r'\s+', ' ', текст)).strip()
        if any(тексты):
            вывод.append('\t'.join(тексты))
    return '\n'.join(вывод), len(найдено)


def разобрать(данные):
    вид = вид_файла(данные)
    if not вид:
        return 400, {'ok': False, 'issue': 'не PDF и не картинка (PNG, JPEG, TIFF)'}
    with tempfile.TemporaryDirectory() as каталог:
        вход = os.path.join(каталог, 'in.' + вид)
        with open(вход, 'wb') as f:
            f.write(данные)
        картинки = [вход]
        if вид == 'pdf':
            р = запустить(['pdftoppm', '-r', '300', '-gray', '-png', '-f', '1', '-l', str(СТРАНИЦ),
                           вход, os.path.join(каталог, 'p')], 300)
            if р.returncode != 0:
                return 502, {'ok': False, 'issue': 'pdftoppm не разрезал PDF: ' + р.stderr.decode('utf-8', 'replace')[:200]}
            картинки = sorted(os.path.join(каталог, ф) for ф in os.listdir(каталог) if re.match(r'^p-\d+\.png$', ф))
        части, всего_ячеек = [], 0
        for к in картинки:
            текст, сколько = страница(к)
            if текст:
                части.append(текст)
                всего_ячеек += сколько
        if not части:
            return 422, {'ok': False, 'issue': 'таблицы на скане не найдено: ни линий, ни колонок по промежуткам'}
        return 200, {'ok': True, 'text': '\f'.join(части), 'страниц': len(картинки),
                     'страницСТаблицей': len(части), 'ячеек': всего_ячеек, 'распознано': True}


class Обработчик(BaseHTTPRequestHandler):
    def отдать(self, код, тело):
        данные = json.dumps(тело, ensure_ascii=False).encode('utf-8')
        self.send_response(код)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(данные)))
        self.end_headers()
        self.wfile.write(данные)

    def do_GET(self):
        if self.path != '/health':
            return self.отдать(404, {'ok': False, 'issue': 'есть только POST /tables и GET /health'})
        try:
            т = запустить(['tesseract', '--list-langs'], 10)
            языки = (т.stdout + т.stderr).decode('utf-8', 'replace')
            if not re.search(r'^rus$', языки, re.M):
                return self.отдать(500, {'ok': False, 'issue': 'у tesseract нет русского языка'})
            self.отдать(200, {'ok': True, 'opencv': cv2.__version__, 'tesseract': 'rus есть'})
        except Exception as e:  # noqa: BLE001 — здоровье отвечает причиной, а не падает
            self.отдать(500, {'ok': False, 'issue': str(e)})

    def do_POST(self):
        if self.path.split('?')[0] != '/tables':
            return self.отдать(404, {'ok': False, 'issue': 'есть только POST /tables и GET /health'})
        длина = int(self.headers.get('Content-Length') or 0)
        if длина <= 0:
            return self.отдать(400, {'ok': False, 'issue': 'тело запроса пустое — файл не прислан'})
        if длина > МАКС_БАЙТ:
            return self.отдать(413, {'ok': False, 'issue': 'файл больше допустимого предела'})
        try:
            код, тело = разобрать(self.rfile.read(длина))
        except subprocess.TimeoutExpired:
            код, тело = 504, {'ok': False, 'issue': 'распознавание не уложилось во время'}
        except Exception as e:  # noqa: BLE001 — сбой одного файла не роняет сервис
            код, тело = 502, {'ok': False, 'issue': 'сбой разбора таблицы: ' + str(e)[:200]}
        print(f'таблицы: код {код}, {тело.get("ячеек", 0)} ячеек, {тело.get("issue", "")}', flush=True)
        self.отдать(код, тело)

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    print(f'сервис таблиц слушает порт {ПОРТ}', flush=True)
    ThreadingHTTPServer(('0.0.0.0', ПОРТ), Обработчик).serve_forever()
