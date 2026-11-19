/**
 * Извлечение текста из приложенных к закупке файлов.
 *
 * Единственный модуль проекта, которому нужен встроенный модуль Node (`zlib`).
 * Внешних зависимостей по-прежнему нет. В Code-ноду n8n переносится как есть:
 * zlib там доступен.
 *
 * РАСКЛАД ПО ФОРМАТАМ (замер 26.09.2026 на 26 файлах из четырёх закупок):
 *
 *   PDF   31%  — в модель уходит файлом, Claude API читает PDF сам.
 *                Разбирать его здесь не нужно и не следует: свой разбор PDF
 *                потеряет таблицы, а таблицы — это позиции лота.
 *   DOCX  27%  — это ZIP с XML внутри, читается здесь.
 *   DOC   27%  — старый двоичный формат Microsoft. НЕ ПОДДЕРЖИВАЕТСЯ.
 *   XLS   12%  — то же самое. НЕ ПОДДЕРЖИВАЕТСЯ.
 *   XLSX   4%  — ZIP с XML, читается здесь.
 *
 * ПРО СТАРЫЕ ФОРМАТЫ MICROSOFT (DOC, XLS, RTF).
 * Это OLE2 — формат со сложной внутренней файловой системой. Написать его
 * разбор без библиотеки можно, но результат будет хрупким и молча неполным,
 * а молчаливая неполнота здесь опаснее отказа: клиент получит условия
 * закупки, в которых часть текста просто отсутствует, и не узнает об этом.
 *
 * Решение владельца от 26.09.2026: на сервере ставится конвертер
 * (LibreOffice в фоновом режиме), файл пересохраняется в DOCX или XLSX и
 * разбирается обычным путём. Такие файлы получают маршрут CONVERT, а не
 * «отказ»: они не потеряны, им нужен один дополнительный шаг.
 *
 * ВАЖНО: если конвертер на сервере не установлен или не отработал,
 * файл обязан стать нечитаемым явно. Подменять непрочитанный документ
 * пустым текстом нельзя — это выглядит как «условий в документе нет».
 */

const zlib = require('zlib');

/** Что делать с файлом. */
const ROUTE = {
  TEXT: 'разобрать в текст',
  FILE: 'отправить файлом в модель',
  CONVERT: 'пересохранить конвертером, затем разобрать',
  UNSUPPORTED: 'формат не поддерживается'
};

const FORMATS = {
  docx: ROUTE.TEXT,
  xlsx: ROUTE.TEXT,
  pdf: ROUTE.FILE,
  doc: ROUTE.CONVERT,
  xls: ROUTE.CONVERT,
  rtf: ROUTE.CONVERT,
  odt: ROUTE.CONVERT,
  ods: ROUTE.CONVERT
};

/** Во что конвертер пересохраняет каждый старый формат. */
const CONVERT_TO = { doc: 'docx', rtf: 'docx', xls: 'xlsx', odt: 'docx', ods: 'xlsx' };

/**
 * Команда пересохранения файла через LibreOffice.
 *
 * ГДЕ ОНА ВЫПОЛНЯЕТСЯ — изменилось 01.10.2026. Раньше предполагалось, что
 * LibreOffice стоит в том же контейнере, что n8n, и команду запускает нода
 * «Выполнить команду». Это оказалось невозможно: образ n8n собран как Docker
 * Hardened Image, менеджер пакетов оттуда вырезан намеренно, установить
 * LibreOffice внутрь нельзя никак (проверено на сервере, apk упал с кодом 127).
 *
 * Теперь конвертер — отдельный контейнер, и эту команду выполняет он сам
 * (deploy/converter/server.js). Воркфлоу вместо запуска команды делает запрос
 * по сети — его описывает conversionRequest(). Сама команда осталась здесь
 * ровно затем, чтобы существовать в проекте в единственном экземпляре:
 * два описания запуска, разошедшиеся со временем, дали бы два разных
 * поведения, и разницу заметил бы только клиент.
 *
 * Ключ --convert-to задаёт формат, --outdir — куда положить результат.
 * Отдельный профиль (-env:UserInstallation) обязателен: без него два
 * одновременных запуска конвертера дерутся за один каталог настроек и
 * второй молча завершается, не создав файла.
 *
 * @param {string} inputPath путь к исходному файлу
 * @param {string} outDir куда положить результат
 * @param {string} format исходный формат (doc, xls, rtf)
 */
// В PDF - только офисные документы (25.10.2026): таблица, вставленная в Word
// рисунком EMF, распознаётся со страницы PDF сервисом таблиц.
const В_PDF = new Set(['doc', 'docx', 'rtf', 'odt', 'xls', 'xlsx', 'ods']);

function conversionCommand(inputPath, outDir, format, цель = null) {
  const f = String(format).toLowerCase();
  const target = цель === 'pdf' ? (В_PDF.has(f) ? 'pdf' : null) : CONVERT_TO[f];
  if (!target) return null;
  // Идентификатор процесса берём осторожно: объекта process нет в песочнице
  // Code-ноды n8n, и обращение к нему роняет ноду целиком («process is not
  // defined»). Здесь он нужен лишь для уникальности имени каталога, поэтому
  // при его отсутствии годится случайное число.
  const метка = (typeof process !== 'undefined' && process && process.pid)
    ? process.pid
    : Math.floor(Math.random() * 1e9);
  const profile = `/tmp/soffice-${метка}-${Date.now()}`;
  return {
    command: 'soffice',
    args: [
      `-env:UserInstallation=file://${profile}`,
      '--headless', '--norestore',
      '--convert-to', target,
      '--outdir', outDir,
      inputPath
    ],
    target,
    timeoutMs: 120000
  };
}

/**
 * Описание запроса к конвертеру для HTTP-ноды n8n.
 *
 * Адрес берётся из переменной окружения CONVERTER_URL, которую задаёт
 * docker-compose, либо передаётся явно третьим аргументом.
 *
 * ПОЧЕМУ НУЖЕН ЯВНЫЙ ВАРИАНТ. В песочнице Code-ноды n8n объекта process нет
 * вовсе — проверено на сервере 03.10.2026, обращение к process.env роняет
 * ноду с «process is not defined». Переменные из docker-compose туда не
 * доходят, и адрес приходится передавать через настройки самой ноды.
 *
 * Жёстко прописывать адрес в каждой ноде всё равно нельзя: при переименовании
 * сервиса забытая нода тихо перестанет конвертировать, и 39% приложенных
 * файлов станут нечитаемыми без единой ошибки в логах. Поэтому он задаётся
 * в одном месте — в блоке настроек воркфлоу.
 *
 * Имя файла уходит параметром, потому что по нему конвертер определяет
 * исходный формат. Формат передаётся вторым параметром отдельно — имена
 * с портала бывают без расширения вовсе.
 *
 * Конвертер отвечает либо самим файлом (код 200), либо JSON с полем issue
 * и кодом 4xx/5xx. Третьего нет: пустой ответ с кодом 200 он не отдаёт
 * никогда — именно чтобы не превратить потерю текста в тихий успех.
 *
 * @param {string} fileName имя исходного файла, как на портале
 * @param {string} format исходный формат (doc, xls, rtf); по умолчанию из имени
 * @param {{url?: string}} [опции] адрес конвертера, если окружение недоступно
 * @returns {object|null} null, если этому формату конвертер не нужен
 */
function conversionRequest(fileName, format, опции = {}) {
  const ext = String(format || '').toLowerCase()
    || ((String(fileName || '').match(/\.([A-Za-z0-9]{1,5})\s*$/) || [])[1] || '').toLowerCase();
  const target = CONVERT_TO[ext];
  if (!target) return null;

  // Адрес берём из окружения, если оно доступно. В песочнице Code-ноды n8n
  // объекта process нет вовсе, и прямое обращение роняет ноду — поэтому
  // адрес можно передать и первым аргументом через опции.
  const изОкружения = (typeof process !== 'undefined' && process && process.env)
    ? process.env.CONVERTER_URL
    : null;
  const base = String(опции.url || изОкружения || 'http://converter:3000').replace(/\/+$/, '');
  const query = `name=${encodeURIComponent(fileName || `file.${ext}`)}&format=${encodeURIComponent(ext)}`;

  return {
    method: 'POST',
    url: `${base}/convert?${query}`,
    headers: { 'Content-Type': 'application/octet-stream' },
    // Ответ — двоичный файл, а не текст. Нода, настроенная на текст,
    // испортит ZIP молча: файл придёт, парсер вернёт пустоту.
    responseFormat: 'file',
    target,
    timeoutMs: 200000
  };
}

// ------------------------------------------------------------------ ZIP

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/**
 * Читает оглавление ZIP-архива.
 *
 * Читаем именно центральный каталог, а не локальные заголовки: у файлов,
 * записанных потоком, в локальном заголовке размеры равны нулю, а настоящие
 * лежат в дескрипторе после данных. Офисные программы так пишут регулярно.
 *
 * @param {Buffer} buf
 * @returns {Array<{name: string, method: number, compSize: number, size: number, offset: number}>}
 */
function readZipDirectory(buf) {
  // Хвостовой комментарий архива может быть до 64 КБ — ищем подпись с конца.
  let eocd = -1;
  const from = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('это не ZIP-архив: не найдено оглавление');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) break;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = имяЗаписи(buf.slice(p + 46, p + 46 + nameLen), flags);
    entries.push({ name, method, compSize, size, offset, encrypted: (flags & 1) === 1 });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Имя записи архива. Бит 11 флагов — имя в UTF-8. Без него архиватор Windows
 * пишет имя в кодировке CP866, и «Описание.docx», прочитанное как UTF-8,
 * превращается в мусор — а по имени определяется назначение файла.
 */
function имяЗаписи(байты, flags) {
  if (flags & 0x800) return байты.toString('utf8');
  if (!байты.some((b) => b >= 0x80)) return байты.toString('latin1');
  try {
    return new TextDecoder('ibm866').decode(байты);
  } catch (e) {
    return байты.toString('utf8');
  }
}

/** Распаковывает одну запись архива. `предел` — сколько байт допускается на выходе. */
function readZipEntry(buf, entry, предел = 0) {
  if (buf.readUInt32LE(entry.offset) !== SIG_LOCAL) {
    throw new Error(`повреждён заголовок записи «${entry.name}»`);
  }
  const nameLen = buf.readUInt16LE(entry.offset + 26);
  const extraLen = buf.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLen + extraLen;
  const data = buf.slice(start, start + entry.compSize);

  if (entry.method === 0) return data;              // без сжатия
  if (entry.method === 8) {                         // deflate
    return предел > 0 ? zlib.inflateRawSync(data, { maxOutputLength: предел }) : zlib.inflateRawSync(data);
  }
  throw new Error(`неизвестный способ сжатия (${entry.method}) в «${entry.name}»`);
}

/**
 * КАЧЕСТВО РАСПОЗНАННОГО ТЕКСТА — 19.10.2026.
 *
 * Повторный разбор 72 закупок: у двух закупок Tesseract вернул из скана
 * обоснования НМЦК «Е ЕЕЕЕЕВ бЕННОЫ ВЕН ВЕРЕ ii» — так выглядит повёрнутая
 * страница. Разбор честно не нашёл таблицы, но причину было не видно, а
 * мусор мог бы и разобраться во что-то правдоподобное.
 *
 * Мера — доля «словесных» токенов: строчных русских слов от четырёх букв
 * с гласной. В обычном документе это десятки процентов, в мусоре единицы.
 * Порог 0,15 — граница здравого смысла по этим двум образцам, не измерение.
 *
 * @returns {{доля: number, токенов: number, годится: boolean}}
 */
function качествоРаспознавания(текст) {
  const токены = String(текст || '').split(/\s+/).filter((т) => т.length >= 2);
  if (!токены.length) return { доля: 0, токенов: 0, годится: false };
  // Заглавная — только первая: «Наименование» — слово, «ЕЕЕЕЕВ» — мусор.
  const слова = токены.filter((т) => /^[А-ЯЁа-яё][а-яё]{3,}[.,;:)]?$/.test(т) && /[аеёиоуыэюя]/.test(т));
  const доля = слова.length / токены.length;
  return { доля: Math.round(доля * 100) / 100, токенов: токены.length, годится: доля >= 0.15 };
}

/**
 * КАРТИНКИ ВНУТРИ DOCX / XLSX (25.10.2026). Заказчик вставляет таблицу расчёта
 * НМЦК в Word картинкой («Результаты расчета … приведены в таблице» - и в
 * тексте её нет, 0372200077526000028, 0322200000826000038). Достаются файлы
 * word/media, xl/media; мелочь (логотипы, подписи, печати до 20 КБ) - нет.
 * EMF/WMF распознать нечем - называются отдельно.
 *
 * @returns {{картинки: Array<{имя: string, данные: Buffer}>, векторных: number}}
 */
function картинкиДокумента(buf, { сколько = 4, отБайт = 20 * 1024, доБайт = 15 * 1024 * 1024 } = {}) {
  let записи;
  try { записи = readZipDirectory(buf); } catch (e) { return { картинки: [], векторных: 0 }; }
  const медиа = записи.filter((з) => /^(word|xl|ppt)\/media\//i.test(з.name) && !з.encrypted);
  const векторных = медиа.filter((з) => /\.(emf|wmf)$/i.test(з.name) && з.size >= отБайт).length;
  const картинки = [];
  for (const з of медиа.filter((з) => /\.(png|jpe?g|tiff?)$/i.test(з.name) && з.size >= отБайт && з.size <= доБайт)
    .sort((a, b) => b.size - a.size).slice(0, сколько)) {
    try { картинки.push({ имя: з.name.split('/').pop(), данные: readZipEntry(buf, з, доБайт) }); } catch (e) { /* пропуск */ }
  }
  return { картинки, векторных };
}

/**
 * МУСОРНЫЙ ТЕКСТОВЫЙ СЛОЙ PDF (25.10.2026, 0855200000526003414): скан с
 * испорченным слоем - pdftotext отдаёт «z :хa :Е ь< ь х -о о i IQ пq», файл
 * считался прочитанным и до распознавания не доходил. Годный токен - слово,
 * число (таблица цифр - не мусор) или короткое русское слово; мусор - когда
 * годных меньше 30% при 50+ токенах. Граница здравого смысла, не измерение.
 */
function мусорныйСлойPdf(текст) {
  const токены = String(текст || '').split(/\s+/).filter(Boolean);
  if (токены.length < 50) return false;
  // Короткое слово - с гласной («на», «шт» не в счёт), однобуквенное - только
  // предлог или союз: «ь», «х», «т» в мусорном слое - не слова.
  const годный = (т) => /^[«"(]?[А-ЯЁа-яёA-Za-z][а-яёa-z-]{2,}[.,;:)»"]?$/.test(т)
    || /^[(№-]?\d[\d.,%/×xх)-]*[.,;:]?$/i.test(т) || (/^[а-яё]{2,3}[.,;:]?$/.test(т) && /[аеёиоуыэюя]/.test(т))
    || /^[ивскоуа]$/.test(т) || /^[А-ЯЁ]{2,6}[.,;:]?$/.test(т) || /^(шт|руб|кг|см|мм|м²|м2)\.?$/i.test(т);
  return токены.filter(годный).length / токены.length < 0.3;
}

/**
 * РАСПАКОВКА ZIP С ДОКУМЕНТАМИ ЗАКУПКИ — 18.10.2026.
 *
 * Фоновый разбор 72 закупок: у 4 из 13 неудач все документы лежали в ZIP
 * («Описание.docx.zip», «Обоснование НМЦК.pdf.zip»), и разбор честно
 * сообщал «позиций нет». Чтение ZIP в проекте уже было — им открываются
 * DOCX и XLSX, — поэтому распаковка своя, без чужих библиотек.
 *
 * Защиты: не больше `записей` файлов; каждый не больше `байт` после
 * распаковки (защита от архива-бомбы, где килобайт разворачивается
 * в гигабайты); зашифрованные, вложенные архивы и папки пропускаются
 * с причиной, а не молча.
 *
 * @returns {{файлы: Array<{имя: string, данные: Buffer}>, пропущено: Array<{имя: string, причина: string}>}}
 */
function распаковатьZip(buf, { записей = 10, байт = 30 * 1024 * 1024, вложенные = false } = {}) {
  const файлы = [];
  const пропущено = [];
  for (const e of readZipDirectory(buf)) {
    const имя = e.name.split('/').pop();
    if (!имя) continue;                                   // папка
    if (e.encrypted) { пропущено.push({ имя, причина: 'зашифрован паролем' }); continue; }
    // Вложенные .zip/.rar/.7z отдаются наружу, если вызывающий раскрывает их
    // сам (один уровень, app/estimate-run.js, 27.10.2026); tar и gz - нет.
    if (/\.(tar|gz)$/i.test(имя) || (!вложенные && /\.(zip|rar|7z)$/i.test(имя))) { пропущено.push({ имя, причина: 'вложенный архив' }); continue; }
    if (/\.(sig|p7s)$/i.test(имя)) continue;              // подпись, не документ
    if (e.size > байт) { пропущено.push({ имя, причина: `больше ${Math.round(байт / 1048576)} МБ` }); continue; }
    if (файлы.length >= записей) { пропущено.push({ имя, причина: `сверх предела в ${записей} файлов` }); continue; }
    try {
      файлы.push({ имя, данные: readZipEntry(buf, e, байт) });
    } catch (err) {
      пропущено.push({ имя, причина: err.message });
    }
  }
  return { файлы, пропущено };
}

// ------------------------------------------------------------------ XML

/** Разворачивает XML-сущности обратно в символы. */
function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&'); // последним, иначе «&amp;lt;» развернётся дважды
}

// ------------------------------------------------------------------ DOCX

/**
 * Текст документа Word.
 *
 * Абзацы и строки таблиц сохраняются переводами строк, ячейки — табуляцией.
 * Это не украшательство: в документации закупки таблицей задаются позиции
 * лота, и склеенные в одну строку ячейки превращают «10 шт по 500 ₽»
 * в неразбираемую кашу.
 */
function extractDocx(buf) {
  const entries = readZipDirectory(buf);
  const doc = entries.find((e) => e.name === 'word/document.xml');
  if (!doc) throw new Error('в архиве нет word/document.xml — это не документ Word');

  const xml = readZipEntry(buf, doc).toString('utf8');
  const out = [];
  let current = '';

  const tagRe = /<([^>]+)>/g;
  let last = 0;
  let m;
  let insideText = false;
  // ЛОВУШКА: каждая ячейка таблицы содержит собственный абзац <w:p>.
  // Если завершать строку по концу абзаца, строка таблицы рассыпается на
  // столбько строк, сколько в ней ячеек, и связь «наименование — количество —
  // единица» теряется. Внутри строки таблицы абзац строку не завершает:
  // её завершает только </w:tr>.
  let inRow = false;

  const flush = () => {
    const line = current.replace(/[\t ]+$/, '').trimEnd();
    if (line) out.push(line);
    current = '';
  };

  while ((m = tagRe.exec(xml)) !== null) {
    if (insideText) current += unescapeXml(xml.slice(last, m.index));
    const tag = m[1];
    last = tagRe.lastIndex;

    if (/^w:t(\s|$|\/)/.test(tag)) insideText = !tag.endsWith('/');
    else if (/^\/w:t$/.test(tag)) insideText = false;
    else if (/^w:tab(\s|\/|$)/.test(tag)) current += '\t';
    else if (/^w:br(\s|\/|$)/.test(tag) || /^w:cr(\s|\/|$)/.test(tag)) current += '\n';
    else if (/^w:tr(\s|\/|$)/.test(tag)) { flush(); inRow = true; }
    else if (/^\/w:tr$/.test(tag)) { inRow = false; flush(); }
    else if (/^\/w:tc$/.test(tag)) current = current.replace(/[\t ]+$/, '') + '\t';
    else if (/^\/w:p$/.test(tag)) {
      // Внутри ячейки абзац лишь разделяет текст пробелом.
      if (inRow) { if (current && !/[\t\s]$/.test(current)) current += ' '; }
      else flush();
    }
  }
  flush();

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ------------------------------------------------------------------ XLSX

/**
 * Текст ячейки Excel: «_x000D_» и прочие «_xHHHH_» - так книга хранит
 * управляющие символы (32616499247, 24.10.2026: наименованием стало
 * «166.55 _x000D_»); перевод строки внутри ячейки - пробел, иначе строка
 * таблицы в тексте рассыпается на несколько, и колонки съезжают.
 */
function текстЯчейки(s) {
  return String(s)
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** Общие строки книги: в ячейках лежат не тексты, а номера в этом списке. */
function readSharedStrings(buf, entries) {
  const e = entries.find((x) => x.name === 'xl/sharedStrings.xml');
  if (!e) return [];
  const xml = readZipEntry(buf, e).toString('utf8');
  const strings = [];
  // <si> может состоять из нескольких <t> — форматированный текст режется на куски.
  for (const si of xml.match(/<si>[\s\S]*?<\/si>/g) || []) {
    const parts = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1]));
    strings.push(текстЯчейки(parts.join('')));
  }
  return strings;
}

/** Номер столбца из ссылки на ячейку: A1 -> 0, B1 -> 1, AA1 -> 26. */
function columnIndex(ref) {
  const letters = (ref.match(/^([A-Z]+)/) || [])[1] || 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Книга Excel в виде строк и ячеек, БЕЗ склейки в текст.
 *
 * ПОЧЕМУ ЭТО ОТДЕЛЬНАЯ ФУНКЦИЯ. Разбору документации нужен текст, а разбору
 * прайс-листа клиента (`src/price-list.js`) нужны именно ячейки: в тексте
 * столбцы уже склеены, и «не нашёл столбец „Цена“» сказать нечем. Второй
 * читатель Excel в проекте завёл бы два описания одного формата, а они
 * расходятся со временем — в проекте это уже было с командой запуска
 * конвертера и с признаками несостоявшейся закупки, и оба раза расхождение
 * замечал бы только клиент. Поэтому читатель один, а представлений два.
 *
 * Пустые ячейки сохраняются как пустые колонки, иначе сдвинутся столбцы и
 * количество из одной позиции приедет к другой.
 *
 * НОМЕРА СТРОК БЕРУТСЯ ИЗ РАЗМЕТКИ, А НЕ СЧИТАЮТСЯ ПО ПОРЯДКУ. Пустые строки в
 * разбор не попадают, поэтому порядковый номер в полученном списке и номер
 * строки, который человек видит в Excel, расходятся — тем сильнее, чем больше
 * пустых строк в шапке файла. Для прайса это не мелочь: номер строки — это
 * единственное подтверждение цены («прайс клиента, строка 42»), и по съехавшему
 * номеру владелец цифру не найдёт, то есть проверить расчёт будет нечем.
 * Найдено проверкой 06.10.2026 на книге с пустой строкой над шапкой.
 *
 * @returns {Array<{лист: number, строки: string[][], номера: number[]}>}
 */
function xlsxRows(buf) {
  const entries = readZipDirectory(buf);
  const shared = readSharedStrings(buf, entries);
  const sheets = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));

  if (sheets.length === 0) throw new Error('в архиве нет листов — это не книга Excel');

  const out = [];
  for (let i = 0; i < sheets.length; i++) {
    const xml = readZipEntry(buf, sheets[i]).toString('utf8');
    const строки = [];
    const номера = [];
    let поПорядку = 0;

    for (const rowM of xml.matchAll(/<row([^>]*)>([\s\S]*?)<\/row>/g)) {
      const rowXml = rowM[2];
      поПорядку++;
      // Атрибут r — номер строки в книге. Его может не быть: тогда строка идёт
      // следующей по порядку, как и задано форматом.
      const r = Number((rowM[1].match(/\sr="(\d+)"/) || [])[1]);
      const номерСтроки = Number.isInteger(r) && r > 0 ? r : поПорядку;
      поПорядку = номерСтроки;

      const cells = [];
      for (const m of rowXml.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = m[1];
        const body = m[2] || '';
        const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1] || '';
        const type = (attrs.match(/t="([^"]+)"/) || [])[1] || 'n';

        let value = '';
        if (type === 's') {
          const idx = Number((body.match(/<v>([\s\S]*?)<\/v>/) || [])[1]);
          value = Number.isInteger(idx) && shared[idx] !== undefined ? shared[idx] : '';
        } else if (type === 'inlineStr') {
          value = текстЯчейки([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unescapeXml(x[1])).join(''));
        } else {
          value = unescapeXml((body.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '');
          if (type === 'str') value = текстЯчейки(value);
        }

        const at = ref ? columnIndex(ref) : cells.length;
        while (cells.length < at) cells.push('');
        cells[at] = value;
      }
      if (cells.some((c) => c !== '')) {
        строки.push(cells);
        номера.push(номерСтроки);
      }
    }

    out.push({ лист: i + 1, строки, номера });
  }
  return out;
}

/**
 * Текст книги Excel: листы, строки, ячейки.
 * Построен на `xlsxRows`, чтобы читатель формата в проекте был один.
 */
function extractXlsx(buf) {
  const листы = xlsxRows(buf);
  const out = [];
  for (const л of листы) {
    if (л.строки.length === 0) continue;
    if (листы.length > 1) out.push(`--- лист ${л.лист} ---`);
    out.push(л.строки.map((c) => c.join('\t')).join('\n'));
  }
  return out.join('\n').trim();
}

// ------------------------------------------------------------------ фасад

/** Определяет формат по содержимому, а не по имени: расширение врёт. */
function sniffFormat(buf, ext = '') {
  if (!buf || buf.length < 8) return ext.toLowerCase();
  if (buf.slice(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
    // OLE2: внутри может быть и Word, и Excel. Различаем ПО СОДЕРЖИМОМУ —
    // по имени потока внутри файла, записанному в UTF-16: «WordDocument»
    // у Word, «Workbook» или «Book» у Excel.
    //
    // Найдено пакетной проверкой 14.10.2026. Файл «Обоснование НМЦК» пришёл
    // без расширения, код посчитал его Word, конвертер пытался сохранить
    // таблицу Excel как документ Word и «отчитался об успехе, но файла не
    // создал». Обоснование НМЦК почти всегда Excel, то есть так терялся
    // самый ценный файл закупки.
    const поток = (имя) => buf.indexOf(Buffer.from(имя, 'utf16le')) !== -1;
    if (поток('WordDocument')) return 'doc';
    if (поток('Workbook') || поток('Book')) return 'xls';
    return ext.toLowerCase() === 'xls' ? 'xls' : 'doc';
  }
  // RTF — текстовый формат Word, на портале встречается без расширения.
  // Пересохраняется конвертером так же, как .doc.
  if (buf.slice(0, 5).toString('latin1') === '{\\rtf') return 'rtf';
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    // ZIP: DOCX или XLSX. Смотрим, что внутри.
    try {
      const names = readZipDirectory(buf).map((e) => e.name);
      if (names.includes('word/document.xml')) return 'docx';
      if (names.some((n) => n.startsWith('xl/'))) return 'xlsx';
      // OpenOffice (ODT/ODS) - тоже ZIP: без этого его распаковывали как архив
      // и читали «mimetype», «content.xml» (24.10.2026, 7 закупок из 118
      // неудач). Вид - по первой записи mimetype, она хранится без сжатия.
      if (names.includes('mimetype') && names.includes('content.xml')) {
        return /opendocument\.spreadsheet/.test(buf.slice(0, 200).toString('latin1')) ? 'ods' : 'odt';
      }
    } catch (e) { /* ниже отдадим расширение */ }
    return ext.toLowerCase() || 'zip';
  }
  return ext.toLowerCase();
}

/**
 * Достаёт текст из файла или объясняет, почему не может.
 *
 * Никогда не бросает исключение: сбой на одном файле не должен ронять разбор
 * всей закупки. Вместо этого возвращает ok: false и внятную причину, которая
 * доходит до человека.
 *
 * @param {Buffer} buffer содержимое файла
 * @param {string} name имя файла — нужно только для сообщений и подсказки формата
 * @returns {{ok: boolean, route: string, format: string, text: string, issue: string}}
 */
function extractText(buffer, name = '') {
  // Расширение обязано начинаться с буквы. Найдено 14.10.2026: файл
  // «Проект контракта, сост. 01.10.2026» без расширения давал формат «2026»
  // и объявлялся неподдерживаемым. Теперь такой файл определяется по содержимому.
  const ext = (String(name).match(/\.([A-Za-z][A-Za-z0-9]{0,4})\s*$/) || [])[1] || '';
  const format = sniffFormat(buffer, ext);
  const route = FORMATS[format] || ROUTE.UNSUPPORTED;
  const base = { route, format, text: '', issue: '' };

  if (!buffer || buffer.length === 0) {
    return { ...base, ok: false, issue: 'файл пуст' };
  }
  if (route === ROUTE.FILE) {
    return { ...base, ok: true, issue: 'PDF отправляется в модель файлом, текст здесь не извлекается' };
  }
  if (route === ROUTE.CONVERT) {
    return {
      ...base,
      ok: false,
      needsConversion: true,
      convertTo: CONVERT_TO[format],
      issue: `старый формат Microsoft (.${format}) — нужно пересохранить конвертером в .${CONVERT_TO[format]}`
    };
  }
  if (route === ROUTE.UNSUPPORTED) {
    return { ...base, ok: false, issue: `формат «${format || 'неизвестен'}» не поддерживается` };
  }

  try {
    const text = format === 'docx' ? extractDocx(buffer) : extractXlsx(buffer);
    if (!text.trim()) {
      return { ...base, ok: false, issue: 'файл разобран, но текста в нём не оказалось' };
    }
    return { ...base, ok: true, text };
  } catch (e) {
    return { ...base, ok: false, issue: `не удалось разобрать: ${e.message}` };
  }
}

/**
 * Раскладывает отобранные документы по способам обработки и говорит,
 * можно ли вообще разбирать эту закупку.
 *
 * Важна последняя проверка. Если прочитать не удалось ничего, закупка НЕ
 * должна тихо уйти с пустым разбором: это выглядит как «условий нет», хотя
 * на деле условия есть, просто в нечитаемом формате.
 *
 * @param {Array<{name: string, buffer: Buffer}>} files
 */
function prepareForModel(files) {
  const texts = [];
  const asFiles = [];
  const toConvert = [];
  const unreadable = [];

  for (const f of files || []) {
    const r = extractText(f.buffer, f.name);
    if (r.route === ROUTE.FILE && r.ok) asFiles.push({ name: f.name, format: r.format });
    else if (r.ok) texts.push({ name: f.name, format: r.format, text: r.text });
    else if (r.needsConversion) {
      toConvert.push({ name: f.name, format: r.format, convertTo: r.convertTo });
    } else unreadable.push({ name: f.name, format: r.format, issue: r.issue });
  }

  const issues = unreadable.map((u) => `«${u.name}»: ${u.issue}`);

  // Файлы на конвертацию — это не проблема, а второй шаг обработки. Проблемой
  // они становятся, только если конвертер не отработал: тогда они вернутся
  // сюда снова и попадут в unreadable.
  const pending = toConvert.length;
  const readable = texts.length + asFiles.length;

  if (readable === 0 && pending === 0 && (files || []).length > 0) {
    issues.push(
      'ни один документ закупки прочитать не удалось — разбор условий невозможен, ' +
      'нужен человек; тихо отдавать пустой результат нельзя'
    );
  }

  return { texts, asFiles, toConvert, unreadable, issues, readable, pending };
}

module.exports = {
  extractText,
  prepareForModel,
  conversionCommand,
  conversionRequest,
  extractDocx,
  extractXlsx,
  xlsxRows,
  readZipDirectory,
  readZipEntry,
  распаковатьZip,
  качествоРаспознавания,
  мусорныйСлойPdf,
  картинкиДокумента,
  sniffFormat,
  ROUTE,
  FORMATS,
  CONVERT_TO
};
