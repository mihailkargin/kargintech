/**
 * Прогон парсера по эталонным фикстурам.
 * Запуск: node tests/run-tests.js
 *
 * Любое изменение парсера прогоняется здесь ДО выкатки на клиентов.
 * Падение теста означает, что менять парсер нельзя, пока причина не понята.
 */
const fs = require('fs');
const path = require('path');
const { parseSearchPage, validateTender, countCardBlocks, documentsUrls } = require('../src/parser');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const EXPECTED = path.join(__dirname, 'expected.json');
// Фиксированная точка отсчёта: иначе тест «срок подачи прошёл» начнёт падать со временем.
const NOW = new Date('2026-09-19T12:00:00Z');

let failures = 0;
const check = (ok, message) => {
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${message}`);
  if (!ok) failures++;
};

// Только страницы поиска. В fixtures/ лежат ещё и страницы документации
// (docs-*.html) — у них другая разметка, и попадание их в этот набор даёт
// ложные падения там, где ничего не сломано.
const files = fs.readdirSync(FIXTURES).filter(f => f.startsWith('search-') && f.endsWith('.html'));
if (files.length === 0) {
  console.error('Фикстур нет. Сначала собрать страницы скриптом _probe/collect-fixtures.ps1');
  process.exit(1);
}

const expected = fs.existsSync(EXPECTED) ? JSON.parse(fs.readFileSync(EXPECTED, 'utf8')) : {};
const actualSummary = {};

for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const html = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
  const tenders = parseSearchPage(html);
  const blocks = countCardBlocks(html);

  console.log(`  Карточек в разметке: ${blocks}, разобрано: ${tenders.length}`);
  // Ключевая проверка: молча пропущенная карточка — самый опасный сбой.
  // Проверять «больше нуля» бесполезно: она пройдёт, даже если из десяти
  // карточек разобралась одна, и клиент тихо недополучит тендеры.
  check(tenders.length === blocks, 'разобраны все карточки, присутствующие в разметке');

  if (blocks === 0) {
    console.log('  Пустая выдача — это штатный результат, дальнейшие проверки пропускаются');
    continue;
  }

  // Поля, присутствующие в карточке любого типа процедуры
  const required = ['number', 'law', 'status', 'orgName', 'orgRole', 'price', 'published', 'url', 'docsUrl'];
  for (const field of required) {
    const filled = tenders.filter(t => t[field] !== null && t[field] !== '' && t[field] !== undefined).length;
    check(filled === tenders.length, `${field}: ${filled}/${tenders.length}`);
  }

  // Объект закупки есть не у всех типов процедур: у закупки по ч.12 ст.93
  // (электронный магазин) поля «Объект закупки» в карточке нет вовсе.
  // Требование то же, что и для срока подачи: не «поле есть всегда», а
  // «без поля карточка не проходит молча». Отбор клиента идёт по ключевым
  // словам в объекте закупки, поэтому пустой объект — это не мелочь: такой
  // тендер нельзя ни отфильтровать, ни уверенно отбросить.
  const noObject = tenders.filter(t => !t.object);
  console.log(`  Без объекта закупки: ${noObject.length}`);
  check(
    noObject.every(t => validateTender(t, NOW).some(i => /объект закупки/.test(i))),
    'карточки без объекта закупки помечены на проверку'
  );

  // Срок подачи присутствует не всегда: у 223-ФЗ способом «Иной способ»
  // поля «Окончание подачи заявок» в карточке может не быть вовсе.
  // Требование не «срок есть всегда», а «без срока карточка не проходит молча».
  const noDeadline = tenders.filter(t => !t.deadline);
  console.log(`  Без срока подачи: ${noDeadline.length}`);
  check(
    noDeadline.every(t => validateTender(t, NOW).some(i => /срок подачи/.test(i))),
    'карточки без срока подачи помечены на проверку'
  );

  // Типы: цена — число, даты — ISO там, где они есть
  check(tenders.every(t => typeof t.price === 'number'), 'НМЦК разобрана в число');
  check(tenders.every(t => t.deadline === null || /^\d{4}-\d{2}-\d{2}$/.test(t.deadline)), 'срок подачи в формате ISO');

  // Утечка разметки в текстовые поля. Ловит целый класс ошибок разбора:
  // в атрибутах ЕИС встречается HTML (data-tooltip), и неаккуратное
  // извлечение затаскивает его содержимое в данные.
  const textFields = ['law', 'status', 'object', 'orgName'];
  const polluted = tenders.filter(t =>
    textFields.some(f => /[<>]|custom-tooltiptext|data-tooltip/.test(t[f] || ''))
  );
  if (polluted.length) {
    polluted.slice(0, 3).forEach(t => console.log(`    ${t.number}: ${JSON.stringify(t.law).slice(0, 120)}`));
  }
  check(polluted.length === 0, 'в текстовых полях нет остатков разметки');

  // Поле закона должно начинаться с указания закона, а не с текста подсказки
  check(tenders.every(t => /^(44-ФЗ|223-ФЗ|ПП РФ)/.test(t.law || '')), 'поле закона начинается с номера закона');

  // Уникальность реестровых номеров внутри страницы
  const unique = new Set(tenders.map(t => t.number));
  check(unique.size === tenders.length, `номера уникальны (${unique.size})`);

  // Адреса страницы документации. Проверено на портале 26.09.2026: у 44-ФЗ
  // ссылка из разметки может отдавать 404 — в ней закодирована стадия
  // процедуры (eap20/zkp20), и она перестаёт работать, когда закупка
  // переходит на следующую стадию. Адрес, выведенный из ссылки на карточку,
  // стадии не содержит (ea20/zk20) и отвечает всегда.
  check(tenders.every(t => documentsUrls(t).length > 0), 'для каждой карточки есть адрес документации');
  check(tenders.every(t => documentsUrls(t).every(u => /^https:\/\/zakupki\.gov\.ru\//.test(u))),
    'все адреса документации абсолютные — относительный путь падает уже на портале');
  check(tenders.every(t => t.url === '' || /^https:\/\/zakupki\.gov\.ru\//.test(t.url)),
    'ссылка на карточку абсолютная');
  check(tenders.every(t => new Set(documentsUrls(t)).size === documentsUrls(t).length),
    'повторов среди кандидатов нет');

  const fz44 = tenders.filter(t => t.number.length === 19 && t.url);
  check(fz44.every(t => !/\/(?:eap|zkp|okp)20\//.test(documentsUrls(t)[0])),
    `у 44-ФЗ первым идёт адрес без стадии в пути (${fz44.length} карточек)`);
  check(fz44.every(t => documentsUrls(t).includes(t.docsUrl)),
    'адрес из разметки не выброшен, а остаётся среди кандидатов');
  const fz223 = tenders.filter(t => t.number.length === 11);
  check(fz223.every(t => documentsUrls(t)[0] === t.docsUrl),
    `у 223-ФЗ первым идёт адрес из разметки — он работает (${fz223.length} карточек)`);

  // Роли организаций разделены, а не слиты
  const roles = tenders.reduce((acc, t) => { acc[t.orgRole] = (acc[t.orgRole] || 0) + 1; return acc; }, {});
  console.log(`  Роли организаций: ${JSON.stringify(roles)}`);
  check(tenders.every(t => !(t.customer && t.placingOrg)), 'заказчик и уполномоченный орган не смешаны в одной карточке');

  // Проверки на правдоподобность
  const flagged = tenders.filter(t => validateTender(t, NOW).length > 0);
  if (flagged.length) {
    console.log(`  Помечено на проверку: ${flagged.length}`);
    flagged.forEach(t => console.log(`    ${t.number}: ${validateTender(t, NOW).join('; ')}`));
  } else {
    console.log('  Помечено на проверку: 0');
  }

  // Сверка с эталоном, если он зафиксирован
  actualSummary[file] = {
    count: tenders.length,
    numbers: tenders.map(t => t.number),
    prices: tenders.map(t => t.price),
    deadlines: tenders.map(t => t.deadline)
  };
  if (expected[file]) {
    const e = expected[file];
    check(e.count === tenders.length, `эталон: количество карточек (${e.count})`);
    check(JSON.stringify(e.numbers) === JSON.stringify(actualSummary[file].numbers), 'эталон: реестровые номера совпадают');
    check(JSON.stringify(e.prices) === JSON.stringify(actualSummary[file].prices), 'эталон: НМЦК совпадают');
    check(JSON.stringify(e.deadlines) === JSON.stringify(actualSummary[file].deadlines), 'эталон: сроки подачи совпадают');
  } else {
    console.log('  Эталон не зафиксирован (запустить с --save-expected)');
  }
}

if (process.argv.includes('--save-expected')) {
  fs.writeFileSync(EXPECTED, JSON.stringify(actualSummary, null, 2), 'utf8');
  console.log(`\nЭталон записан: ${EXPECTED}`);
  console.log('Значения выверить глазами перед коммитом — дальше они становятся точкой отсчёта.');
}

console.log(`\n${failures === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : 'ПРОВАЛЕНО ПРОВЕРОК: ' + failures}`);
process.exit(failures === 0 ? 0 : 1);
