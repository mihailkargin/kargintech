/**
 * Тесты извлечения текста из файлов документации.
 * Запуск: node tests/test-extract-text.js
 *
 * Фикстуры DOCX и XLSX собираются здесь же настоящими ZIP-архивами со сжатием
 * deflate — то есть проверяется весь путь: оглавление архива, распаковка,
 * разбор XML. Это не подменяет проверку на реальных файлах с портала, и
 * отдельный раздел ниже проверяет то, что реально скачано.
 *
 * Главное, что здесь доказывается: таблицы не схлопываются. В документации
 * закупки позиции лота заданы таблицей, и потеря границ ячеек превращает
 * «10 шт по 500 ₽» в нечитаемую кашу, из которой модель придумает что угодно.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {
  extractText, prepareForModel, conversionCommand, conversionRequest,
  extractDocx, extractXlsx, sniffFormat, ROUTE
} = require('../src/extract-text');

let failures = 0;
const check = (ok, message) => {
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${message}`);
  if (!ok) failures++;
};
const section = (name) => console.log(`\n=== ${name} ===`);

// ----------------------------------------------------------- сборка фикстур

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

/** Собирает настоящий ZIP. compress=false кладёт запись без сжатия. */
function makeZip(files, compress = true) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf8');
    const data = compress ? zlib.deflateRawSync(raw) : raw;
    const method = compress ? 8 : 0;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, cdBuf, eocd]);
}

const p = (runs) => `<w:p>${runs}</w:p>`;
const t = (s) => `<w:r><w:t xml:space="preserve">${s}</w:t></w:r>`;

const DOCX = makeZip({
  '[Content_Types].xml': '<Types/>',
  'word/document.xml':
    '<?xml version="1.0"?><w:document><w:body>' +
    p(t('Техническое задание')) +
    p(t('Срок поставки: 30 дней с даты заключения контракта')) +
    p(t('Обеспечение &quot;заявки&quot;: 1% от НМЦК &amp; не более 5%')) +
    '<w:tbl>' +
      '<w:tr><w:tc>' + p(t('Наименование')) + '</w:tc><w:tc>' + p(t('Кол-во')) + '</w:tc><w:tc>' + p(t('Ед.')) + '</w:tc></w:tr>' +
      '<w:tr><w:tc>' + p(t('Бумага А4 80 г/м2')) + '</w:tc><w:tc>' + p(t('500')) + '</w:tc><w:tc>' + p(t('упак')) + '</w:tc></w:tr>' +
      '<w:tr><w:tc>' + p(t('Папка-регистратор')) + '</w:tc><w:tc>' + p(t('300')) + '</w:tc><w:tc>' + p(t('шт')) + '</w:tc></w:tr>' +
    '</w:tbl>' +
    p(t('Место') + '<w:tab/>' + t('поставки') + '<w:br/>' + t('г. Москва')) +
    '</w:body></w:document>'
});

const XLSX = makeZip({
  'xl/sharedStrings.xml':
    '<sst><si><t>Наименование</t></si><si><t>Цена</t></si>' +
    '<si><t>Бумага </t><t>А4</t></si><si><t>ООО «Поставщик»</t></si></sst>',
  'xl/worksheets/sheet1.xml':
    '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>320.50</v></c></row>' +
    // Пропущенный столбец B: значение стоит в C, и оно не должно уехать в B.
    '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="C3"><v>1200</v></c></row>' +
    '<row r="4"><c r="A4" t="inlineStr"><is><t>Итого</t></is></c><c r="B4"><v>1520.5</v></c></row>' +
    '</sheetData></worksheet>'
});

// ----------------------------------------------------------- проверки

section('Определение формата по содержимому, а не по имени');
check(sniffFormat(DOCX, 'docx') === 'docx', 'DOCX опознан');
check(sniffFormat(XLSX, 'xlsx') === 'xlsx', 'XLSX опознан');
check(sniffFormat(Buffer.from('%PDF-1.7\n...'), 'pdf') === 'pdf', 'PDF опознан');
check(sniffFormat(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]), 'xls') === 'xls', 'старый Excel опознан');
check(sniffFormat(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]), 'doc') === 'doc', 'старый Word опознан');
// Расширение врёт — содержимое важнее.
check(sniffFormat(DOCX, 'pdf') === 'docx', 'при вранье расширения побеждает содержимое');

section('Word: текст, абзацы, спецсимволы');
const docx = extractText(DOCX, 'Техническое задание.docx');
check(docx.ok, `разобран${docx.ok ? '' : ': ' + docx.issue}`);
console.log('  --- что получилось ---');
docx.text.split('\n').forEach((l) => console.log('  | ' + l));
check(/Срок поставки: 30 дней/.test(docx.text), 'текст абзаца на месте');
check(docx.text.includes('Обеспечение "заявки": 1% от НМЦК & не более 5%'),
  'XML-сущности развёрнуты обратно в кавычки и амперсанд');
check(!/&amp;|&quot;|<w:/.test(docx.text), 'в тексте нет остатков разметки');

section('Word: ТАБЛИЦЫ НЕ СХЛОПЫВАЮТСЯ');
// В документации закупки позиции лота заданы таблицей. Если границы ячеек
// потерять, количество из одной строки приедет к другой позиции.
const rows = docx.text.split('\n').filter((l) => l.includes('\t'));
check(rows.some((r) => r.split('\t').length === 3),
  'строка таблицы разбита ровно на три ячейки');
check(docx.text.includes('Бумага А4 80 г/м2\t500\tупак'),
  'позиция, количество и единица остались в одной строке и разделены табуляцией');
check(docx.text.includes('Папка-регистратор\t300\tшт'), 'вторая позиция тоже цела');
check(!/500\s*300/.test(docx.text.replace(/\t/g, ' ')), 'количества разных позиций не слиплись');

section('Word: переносы и табуляция внутри абзаца');
check(/Место\tпоставки/.test(docx.text), 'табуляция внутри абзаца сохранена');
check(/поставки\nг\. Москва/.test(docx.text), 'разрыв строки превратился в перевод строки');

section('Excel: значения, общие строки, числа');
const xlsx = extractText(XLSX, 'Обоснование НМЦК.xlsx');
check(xlsx.ok, `разобран${xlsx.ok ? '' : ': ' + xlsx.issue}`);
console.log('  --- что получилось ---');
xlsx.text.split('\n').forEach((l) => console.log('  | ' + l.replace(/\t/g, ' → ')));
check(/Наименование\tЦена/.test(xlsx.text), 'заголовок из общих строк собран');
check(/Бумага А4\t320\.50/.test(xlsx.text), 'составная общая строка склеена, число рядом');
check(/Итого\t1520\.5/.test(xlsx.text), 'строка, заданная прямо в ячейке, прочитана');
check(/ООО «Поставщик»/.test(xlsx.text), 'кириллица и кавычки целы');

section('Excel: ПРОПУЩЕННЫЙ СТОЛБЕЦ НЕ СДВИГАЕТ ДАННЫЕ');
// Это тихая ошибка: если пустую ячейку не сохранить, цена из столбца C
// приедет в столбец B и окажется привязана не к тому показателю.
const row3 = xlsx.text.split('\n').find((l) => l.startsWith('ООО «Поставщик»'));
check(row3 && row3.split('\t').length === 3, `в строке три колонки, вторая пустая (${row3 ? row3.split('\t').length : 0})`);
check(row3 && row3.split('\t')[1] === '' && row3.split('\t')[2] === '1200',
  'значение осталось в третьей колонке, а не переехало во вторую');

section('Архив без сжатия читается так же');
const stored = makeZip({
  'word/document.xml': '<w:document><w:body>' + p(t('Без сжатия')) + '</w:body></w:document>'
}, false);
const st = extractText(stored, 'a.docx');
check(st.ok && /Без сжатия/.test(st.text), 'запись, сохранённая без сжатия, прочитана');

section('PDF в модель уходит файлом, а не текстом');
const pdf = extractText(Buffer.from('%PDF-1.7\n1 0 obj\n'), 'Техническое задание.pdf');
check(pdf.ok, 'PDF признан пригодным');
check(pdf.route === ROUTE.FILE, `маршрут «${pdf.route}»`);
check(pdf.text === '', 'текст здесь намеренно не извлекается — модель прочитает файл сама');
check(/файлом/.test(pdf.issue), 'сказано, почему текста нет');

section('Старые форматы Microsoft уходят на конвертацию');
// Решение владельца от 26.09.2026: на сервере ставится конвертер. Такие файлы
// не потеряны — им нужен один дополнительный шаг.
const doc = extractText(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]), 'Документация.doc');
check(doc.route === ROUTE.CONVERT, `маршрут «${doc.route}»`);
check(doc.needsConversion === true, 'помечен как требующий конвертации');
check(doc.convertTo === 'docx', `сказано, во что пересохранять (${doc.convertTo})`);
check(doc.ok === false && doc.text === '', 'до конвертации текста нет и выдуманного тоже нет');

const xls = extractText(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]), 'Смета.xls');
check(xls.convertTo === 'xlsx', `старый Excel пересохраняется в xlsx (${xls.convertTo})`);

// «_x000D_» и перевод строки внутри ячейки Excel (32616499247, 24.10.2026).
{
  const книга = makeZip({
    'xl/sharedStrings.xml': '<sst><si><t>Набор цветных карандашей,_x000D_\n12 цветов</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>100</v></c><c r="C1"><v>166.55</v></c></row></sheetData></worksheet>'
  });
  const р = extractText(книга, 'НМЦК_Расчёт.xlsx');
  check(р.ok && /Набор цветных карандашей, 12 цветов\t100\t166\.55/.test(р.text) && !/_x000D_/.test(р.text),
    `«_x000D_» раскодирован, ячейка не разбита на строки (${JSON.stringify(String(р.text).slice(0, 80))})`);
}

// OpenOffice - тоже ZIP; раньше его распаковывали как архив (24.10.2026).
const odt = extractText(makeZip({ mimetype: 'application/vnd.oasis.opendocument.text', 'content.xml': '<x/>', 'meta.xml': '<m/>' }, false), 'Приложение №1 Описание');
check(odt.route === ROUTE.CONVERT && odt.convertTo === 'docx', `ODT без расширения - на конвертацию в docx (${odt.route}, ${odt.convertTo})`);
const ods = extractText(makeZip({ mimetype: 'application/vnd.oasis.opendocument.spreadsheet', 'content.xml': '<x/>' }, false), 'Обоснование.ods');
check(ods.convertTo === 'xlsx', `ODS - в xlsx (${ods.convertTo})`);

section('Команда конвертера');
const cmd = conversionCommand('/data/in/Документация.doc', '/data/out', 'doc');
check(cmd && cmd.command === 'soffice', 'команда собрана');
check(cmd.args.includes('--headless'), 'конвертер запускается без окон');
check(cmd.args.includes('--convert-to') && cmd.args.includes('docx'), 'формат назначения передан');
check(cmd.args.some((a) => /UserInstallation=file:\/\//.test(a)),
  'у запуска свой профиль — иначе два одновременных запуска подерутся за каталог настроек');
check(cmd.args[cmd.args.length - 1] === '/data/in/Документация.doc', 'исходный файл идёт последним');
check(typeof cmd.timeoutMs === 'number' && cmd.timeoutMs > 0,
  'задан предел времени — зависший конвертер не должен держать очередь');
check(conversionCommand('/a/b.pdf', '/out', 'pdf') === null, 'для PDF конвертация не предлагается');
// Два вызова подряд не должны дать один и тот же профиль.
check(conversionCommand('/a/b.doc', '/o', 'doc').args[0] !== undefined, 'профиль задан всегда');

section('Запрос к конвертеру по сети');
// С 01.10.2026 конвертер живёт отдельным контейнером: внутрь образа n8n его
// поставить нельзя, менеджер пакетов оттуда вырезан. Поэтому воркфлоу не
// запускает команду, а делает запрос — и у этого запроса свои ловушки.
const savedUrl = process.env.CONVERTER_URL;

process.env.CONVERTER_URL = 'http://converter:3000';
const rq = conversionRequest('Документация (ред. 2).doc');
check(rq !== null && rq.method === 'POST', 'запрос собран методом POST');
check(rq.url.startsWith('http://converter:3000/convert?'), `адрес взят из CONVERTER_URL: ${rq.url.slice(0, 40)}…`);
check(/name=%D0%94/.test(rq.url),
  'кириллица и пробелы в имени закодированы — иначе адрес разъедется на пробеле');
check(/format=doc(&|$)/.test(rq.url), 'формат передан отдельным параметром');
check(rq.target === 'docx', 'сказано, во что пересохраняем');
check(rq.responseFormat === 'file',
  'ответ ожидается файлом: нода, настроенная на текст, испортит ZIP молча');
check(typeof rq.timeoutMs === 'number' && rq.timeoutMs > 0, 'задан предел времени');

// Расширения может не быть вовсе — у части файлов на портале его нет.
check(conversionRequest('Приложение', 'xls').target === 'xlsx',
  'формат можно передать явно, когда в имени расширения нет');
check(conversionRequest('смета.pdf') === null, 'для PDF запрос не собирается');
check(conversionRequest('файл.bin') === null, 'для незнакомого формата запрос не собирается');

// Лишняя косая черта в переменной — классический способ получить //convert.
process.env.CONVERTER_URL = 'http://converter:3000/';
check(!/\/\/convert/.test(conversionRequest('a.doc').url.replace('http://', '')),
  'лишняя косая черта в CONVERTER_URL не удваивается в адресе');

delete process.env.CONVERTER_URL;
check(/^http:\/\/converter:3000\/convert/.test(conversionRequest('a.doc').url),
  'без переменной берётся имя сервиса из docker-compose, а не пустая строка');

if (savedUrl === undefined) delete process.env.CONVERTER_URL;
else process.env.CONVERTER_URL = savedUrl;

section('Формат, который не спасёт и конвертер');
const junk = extractText(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]), 'файл.bin');
check(!junk.ok && junk.route === ROUTE.UNSUPPORTED, 'неизвестный формат отклонён');
check(!junk.needsConversion, 'на конвертацию не отправляется');

section('Настоящий файл с портала');
const realXls = path.join(__dirname, '..', 'fixtures', 'phase3', 'nmck-fz44-1.xls');
if (fs.existsSync(realXls)) {
  const buf = fs.readFileSync(realXls);
  const real = extractText(buf, 'Обоснование начальной (максимальной) цены.xls');
  console.log(`  файл: ${buf.length} байт, формат определён как «${real.format}»`);
  check(real.format === 'xls', 'настоящий файл обоснования НМЦК опознан как старый Excel');
  check(real.route === ROUTE.CONVERT && real.convertTo === 'xlsx',
    'отправлен на конвертацию, а не разобран наполовину');
} else {
  console.log('  ! файла fixtures/phase3/nmck-fz44-1.xls нет, раздел пропущен');
}

section('Битый вход не роняет разбор');
check(extractText(Buffer.alloc(0), 'a.docx').ok === false, 'пустой файл');
check(/пуст/.test(extractText(Buffer.alloc(0), 'a.docx').issue), 'и сказано, что он пуст');
const notZip = extractText(Buffer.from('это просто текст, а не архив'), 'a.docx');
check(!notZip.ok && /не удалось разобрать|не ZIP/.test(notZip.issue),
  `мусор вместо архива не бросает исключение: «${notZip.issue.slice(0, 50)}»`);
const emptyDocx = extractText(makeZip({ 'word/document.xml': '<w:document><w:body></w:body></w:document>' }), 'a.docx');
check(!emptyDocx.ok && /текста в нём не оказалось/.test(emptyDocx.issue),
  'пустой документ не выдаётся за успешно разобранный');
const wrongZip = extractText(makeZip({ 'readme.txt': 'привет' }), 'a.docx');
check(!wrongZip.ok, 'архив без document.xml отклонён');

section('Раскладка комплекта документов по маршрутам');
const prepared = prepareForModel([
  { name: 'Документация.docx', buffer: DOCX },
  { name: 'Обоснование.xlsx', buffer: XLSX },
  { name: 'Техзадание.pdf', buffer: Buffer.from('%PDF-1.7\n') },
  { name: 'Проект контракта.doc', buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]) }
]);
check(prepared.texts.length === 2, `в текст разобрано 2 (${prepared.texts.length})`);
check(prepared.asFiles.length === 1, `файлом в модель уходит 1 (${prepared.asFiles.length})`);
check(prepared.toConvert.length === 1, `на конвертацию 1 (${prepared.toConvert.length})`);
check(prepared.toConvert[0].name === 'Проект контракта.doc', 'на конвертацию ушёл именно старый Word');
check(prepared.unreadable.length === 0, 'нечитаемых нет — старый формат теперь не тупик');
check(prepared.readable === 3 && prepared.pending === 1, 'подсчёт сходится: 3 готовы, 1 ждёт конвертера');

section('ТИХИЙ ОТКАЗ: конвертер не отработал');
// Если файлы вернулись после конвертации всё теми же, значит конвертер
// не установлен или упал. Вот тогда это настоящая авария.
const allBad = prepareForModel([
  { name: 'Документация.bin', buffer: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]) },
  { name: 'Смета.bin', buffer: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]) }
]);
check(allBad.readable === 0 && allBad.pending === 0, 'ни пригодных, ни ожидающих');
check(allBad.issues.some((i) => /разбор условий невозможен/.test(i)),
  'сказано прямо: разбор невозможен');
check(allBad.issues.some((i) => /тихо отдавать пустой результат нельзя/.test(i)),
  'и что пустой результат отдавать нельзя — иначе выглядит как «условий нет»');

const onlyPending = prepareForModel([
  { name: 'Документация.doc', buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]) }
]);
check(onlyPending.pending === 1 && onlyPending.issues.length === 0,
  'закупка только из старых форматов — не авария, а ожидание конвертера');

const nothing = prepareForModel([]);
check(nothing.issues.length === 0, 'пустой список файлов сам по себе тревоги не вызывает');

console.log('\n=== Распаковка ZIP с документами закупки, 18.10.2026 ===');
{
  const zlibЛок = require('zlib');
  const { распаковатьZip } = require('../src/extract-text');
  // Минимальный ZIP: локальные заголовки + центральный каталог + конец.
  // Контрольная сумма не проверяется разбором, поэтому ноль.
  const собрать = (записи) => {
    const части = [];
    const каталог = [];
    let смещение = 0;
    for (const з of записи) {
      const имя = з.имяБайты || Buffer.from(з.имя, 'utf8');
      const сжато = з.метод === 8 ? zlibЛок.deflateRawSync(з.данные) : з.данные;
      const размер = з.заявленныйРазмер ?? з.данные.length;
      const loc = Buffer.alloc(30);
      loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(з.флаги || 0, 6); loc.writeUInt16LE(з.метод || 0, 8);
      loc.writeUInt32LE(сжато.length, 18); loc.writeUInt32LE(размер, 22); loc.writeUInt16LE(имя.length, 26);
      части.push(loc, имя, сжато);
      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(з.флаги || 0, 8); cen.writeUInt16LE(з.метод || 0, 10);
      cen.writeUInt32LE(сжато.length, 20); cen.writeUInt32LE(размер, 24); cen.writeUInt16LE(имя.length, 28);
      cen.writeUInt32LE(смещение, 42);
      каталог.push(cen, имя);
      смещение += 30 + имя.length + сжато.length;
    }
    const кат = Buffer.concat(каталог);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(записи.length, 8); end.writeUInt16LE(записи.length, 10);
    end.writeUInt32LE(кат.length, 12); end.writeUInt32LE(смещение, 16);
    return Buffer.concat([...части, кат, end]);
  };
  // «Описание.docx» в CP866 — так пишут имена архиваторы Windows без флага UTF-8.
  const cp866 = Buffer.from([0x8e, 0xaf, 0xa8, 0xe1, 0xa0, 0xad, 0xa8, 0xa5, 0x2e, 0x64, 0x6f, 0x63, 0x78]);
  const архив = собрать([
    { имя: 'Обоснование.xlsx', флаги: 0x800, данные: Buffer.from('таблица') },
    { имяБайты: cp866, данные: Buffer.from('описание') },
    { имя: 'вложенный.zip', флаги: 0x800, данные: Buffer.from('PK') },
    { имя: 'секрет.docx', флаги: 0x801, данные: Buffer.from('x') },
    { имя: 'подпись.sig', данные: Buffer.from('x') },
    { имя: 'папка/', данные: Buffer.alloc(0) }
  ]);
  const р = распаковатьZip(архив);
  const имена = р.файлы.map((ф) => ф.имя);
  check(имена.includes('Обоснование.xlsx'), 'имя с флагом UTF-8 прочитано');
  check(имена.includes('Описание.docx'), `имя в CP866 прочитано по-русски (${имена.join(', ')})`);
  check(р.файлы.find((ф) => ф.имя === 'Обоснование.xlsx').данные.toString() === 'таблица', 'содержимое не испорчено');
  check(р.пропущено.some((п) => /вложенный/.test(п.причина)), 'вложенный архив пропущен с причиной');
  check(р.пропущено.some((п) => /пароле/.test(п.причина)), 'зашифрованный файл пропущен с причиной');
  check(!имена.includes('подпись.sig') && имена.length === 2, 'подпись и папка не считаются документами');

  // Отрицательный контроль: без поддержки CP866 имя превращается в мусор.
  check(cp866.toString('utf8') !== 'Описание.docx', 'то же имя, прочитанное как UTF-8, действительно мусор');

  // Архив-бомба: 40 МБ нулей сжимаются в десятки килобайт.
  const бомба = Buffer.alloc(40 * 1024 * 1024);
  const честная = распаковатьZip(собрать([{ имя: 'a.docx', флаги: 0x800, метод: 8, данные: бомба }]));
  check(честная.файлы.length === 0 && /больше/.test(честная.пропущено[0].причина),
    'файл больше предела по заявленному размеру не распаковывается');
  const лживая = распаковатьZip(собрать([{ имя: 'b.docx', флаги: 0x800, метод: 8, данные: бомба, заявленныйРазмер: 100 }]));
  check(лживая.файлы.length === 0 && лживая.пропущено.length === 1,
    'заниженный размер в заголовке не помогает — распаковка обрывается на пределе');

  // Архив в архиве (32616483708, 27.10.2026): ТЗ лежало в «Приложение №1 ТЗ.zip».
  const внутренний = собрать([{ имя: 'ТЗ.docx', флаги: 0x800, данные: Buffer.from('позиции') }]);
  const внешний = собрать([
    { имя: 'Приложение №1 ТЗ.zip', флаги: 0x800, данные: внутренний },
    { имя: 'старый.tar', флаги: 0x800, данные: Buffer.from('x') }
  ]);
  const безВложенных = распаковатьZip(внешний);
  check(безВложенных.файлы.length === 0 && безВложенных.пропущено.length === 2,
    'без флага вложенные архивы пропускаются с причиной');
  const сВложенными = распаковатьZip(внешний, { вложенные: true });
  const вл = сВложенными.файлы.find((ф) => ф.имя === 'Приложение №1 ТЗ.zip');
  check(вл && распаковатьZip(вл.данные).файлы[0].имя === 'ТЗ.docx',
    'с флагом вложенный ZIP отдаётся целиком и раскрывается следующим вызовом');
  check(сВложенными.пропущено.some((п) => п.имя === 'старый.tar'), 'tar внутри по-прежнему пропускается');
}

console.log('\n=== Качество распознанного скана — образцы с портала, 19.10.2026 ===');
{
  const { качествоРаспознавания } = require('../src/extract-text');
  // Дословно из журнала: обоснование НМЦК закупок 0190200000326011772 и …756.
  const мусор1 = 'ar 8 THE Zeseer ИН Eeraae? Е5 бо г ‘3855532 23338 2 Е ЕЕЕЕЕВ бЕННОЫ вы ЕВ besos $ НЕЕ 5 и ВЕН ВЕРЕ ii = ^ a 5 35553 1-Е Зо ЕЕ Е ВНЕ TEE';
  const мусор2 = 'энг зузавем ЕЕ: -е- ххт $5293 88 £8355353 $2528 6 Е ЕЕ ЕЕ |, к-} хо b a nn УЕ 22 sage od ge > n 5 ВЕ Е ease ЕЕ eo 2 BEd: 3 g g i Е НЕ ЗЕЕ';
  // Нормальный текст того же рода — из PDF с текстовым слоем той же выборки.
  const норма = 'Наименование организации: МУНИЦИПАЛЬНОЕ БЮДЖЕТНОЕ ОБЩЕОБРАЗОВАТЕЛЬНОЕ Сведения о заказчике: '
    + 'Основные характеристики В соответствии с описанием объекта закупки Используемый метод определения НМЦК '
    + 'Сопоставимых рыночных цен (анализ рынка) Расчет НМЦК: 82 082,50 руб.';
  const таблица = '№ Наименование товара Кол-во Цена 1 Бумага для офисной техники А4 пачка 250 310,00 2 Бумага для офисной техники А3 пачка 40 620,00';
  check(!качествоРаспознавания(мусор1).годится && !качествоРаспознавания(мусор2).годится,
    'мусор повёрнутого скана признан нечитаемым');
  check(качествоРаспознавания(норма).годится && качествоРаспознавания(таблица).годится,
    'нормальный текст и строки таблицы с числами — годны');
  check(!качествоРаспознавания('').годится, 'пустой текст не годен');
  // Слово целиком из заглавных букв словом не считается — иначе «ЕЕЕЕЕВ» прошло бы.
  check(!качествоРаспознавания('ЕЕЕЕЕВ ВЕРЕВ ЕЕВЕЕ НЕЕЕ').годится, 'строки из одних заглавных — мусор');
}

console.log('\n--- картинки внутри DOCX (таблица НМЦК картинкой, 25.10.2026) ---');
{
  const { картинкиДокумента } = require('../src/extract-text');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60000, 7)]);
  const docx = makeZip({ 'word/document.xml': '<w:document/>', 'word/media/image1.png': png, 'word/media/logo.png': Buffer.alloc(3000, 1),
    'word/media/image2.emf': Buffer.alloc(40000, 2) });
  const к = картинкиДокумента(docx);
  check(к.картинки.length === 1 && к.картинки[0].имя === 'image1.png' && к.картинки[0].данные.equals(png), 'большая картинка достана целиком, логотип до 20 КБ - нет');
  check(к.векторных === 1, 'EMF посчитан отдельно - распознать нечем');
  check(картинкиДокумента(Buffer.from('не архив')).картинки.length === 0, 'не ZIP - пусто, без исключения');
}

console.log('\n--- мусорный текстовый слой PDF (25.10.2026, дословно с сервера) ---');
{
  const { мусорныйСлойPdf } = require('../src/extract-text');
  const мусор = 'z :хa :Е 3 g ь< ь х -о о i IQ i l пq Е ; g т с я Е ?ci r Ё,: Е з,6 j,] е 6:ч l Е =,;Ё ; j gs ;*ФS Е f =9 € с;с ъ s(об - * а \\:* о а S -l I а:р=Ф в; ,,.ч-9 ч б ъ';
  check(мусорныйСлойPdf(мусор), 'слой 0855200000526003414 - мусор, файл идёт на распознавание');
  check(мусорныйСлойPdf('}rl El Фl !9l :l .ll дl EI Бl El Hl ýl о зl Ёl 1l ol Dl ? бl xl El 2 l ; яl о ýl ol oll El о о о ol El Ф ol г х Ф яl Dl Ф Е ol $l о Ф бl Yl ех о ^ Ё о i Pl Ф яФ'), 'слой 0829500001126006875 - мусор');
  // Отрицательные контроли: обычный текст и таблица из одних цифр - не мусор.
  check(!мусорныйСлойPdf(('ОБОСНОВАНИЕ НАЧАЛЬНОЙ (МАКСИМАЛЬНОЙ) ЦЕНЫ КОНТРАКТА Начальная цена контракта определена методом сопоставимых рыночных цен ').repeat(6)), 'обычный текст - не мусор');
  check(!мусорныйСлойPdf(('1 Бумага А4 пачка 400 360,80 360,00 377,50 366,10 146 440,00 ').repeat(8)), 'таблица цифр - не мусор');
}

console.log(`\n${failures === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : 'ПРОВАЛЕНО ПРОВЕРОК: ' + failures}`);
process.exit(failures === 0 ? 0 : 1);
