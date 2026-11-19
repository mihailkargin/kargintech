/**
 * Тесты разбора страницы документации закупки.
 * Запуск: node tests/test-docs-page.js
 *
 * Проверяется на реальной сохранённой странице 223-ФЗ плюс на искусственных
 * случаях для ловушек, которых на этой конкретной странице не встретилось.
 *
 * Страница 44-ФЗ пока не собрана — портал вернул 404 по ссылке из сохранённой
 * выдачи. Когда она появится, сюда добавляется такой же блок проверок, и до
 * тех пор разбор 44-ФЗ считается непроверенным.
 */
const fs = require('fs');
const path = require('path');
const {
  parseDocumentsPage,
  validateDocumentsPage,
  selectForExtraction
} = require('../src/docs-page');

let failures = 0;
const check = (ok, message) => {
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${message}`);
  if (!ok) failures++;
};
const section = (name) => console.log(`\n=== ${name} ===`);

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const docsFiles = fs.readdirSync(FIXTURES).filter((f) => f.startsWith('docs-') && f.endsWith('.html'));

section('Эталонные страницы на месте');
check(docsFiles.length > 0, `страниц документации в fixtures: ${docsFiles.length}`);
const has44 = docsFiles.some((f) => f.startsWith('docs-fz44-'));
console.log(`  ${has44 ? 'OK  ' : '  ! '} страница 44-ФЗ ${has44 ? 'собрана' : 'НЕ собрана — разбор 44-ФЗ не проверен'}`);

for (const file of docsFiles) {
  const law = file.startsWith('docs-fz44-') ? '44-ФЗ' : '223-ФЗ';
  section(`${file}  [${law}]`);

  const html = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
  const parsed = parseDocumentsPage(html);

  // Сколько ссылок на скачивание есть в разметке — независимый подсчёт.
  // Он ловит молча пропущенные файлы: их отсутствие не вызовет никакой ошибки.
  const inMarkup = new Set(
    [...html.matchAll(/filestore\/[^"']*file\.html\?[^"']*uid=([^&"']+)/gi)].map((m) => m[1])
  );
  console.log(`  Ссылок на файлы в разметке: ${inMarkup.size}, разобрано: ${parsed.files.length}`);
  check(parsed.files.length === inMarkup.size, 'разобраны все файлы, присутствующие в разметке');
  check(parsed.files.length > 0, 'список файлов не пуст');

  check(parsed.files.every((f) => f.name), 'у каждого файла есть имя');
  check(parsed.files.every((f) => /^https:\/\/zakupki\.gov\.ru\//.test(f.url)), 'все ссылки абсолютные');
  check(parsed.files.every((f) => f.uid), 'у каждого файла есть идентификатор');
  check(new Set(parsed.files.map((f) => f.uid)).size === parsed.files.length, 'дублей нет');
  check(parsed.files.every((f) => f.ext), 'у каждого файла определён тип');

  // ЛОВУШКА: в data-tooltip лежит HTML, и наивный шаблон утаскивает имя дважды.
  check(parsed.files.every((f) => !/custom-tooltiptext|<span|<\/a>/i.test(f.name)),
    'в именах файлов нет остатков разметки');
  check(parsed.files.every((f) => {
    const base = f.name.replace(/\.[A-Za-z0-9]{1,5}$/, '').trim();
    return base.length < 4 || !base.includes(base.slice(0, Math.ceil(base.length / 2)) + base.slice(0, 4));
  }), 'имя файла не продублировано само в себе');

  // ЛОВУШКА: ссылок на просмотр подписи больше, чем файлов.
  const signLinks = (html.match(/signview\/listModal/g) || []).length;
  console.log(`  Ссылок на просмотр подписи: ${signLinks}`);
  check(parsed.files.every((f) => !/signview|listModal/i.test(f.url)),
    'ссылки на просмотр электронной подписи не приняты за файлы');

  // Разметка подписей у двух законов разная: 223-ФЗ — attachment__text,
  // 44-ФЗ — section__attrib. Поддержав только одну, мы молча остаёмся без
  // сведений о редакции и не узнаём, что разбираем устаревшие документы.
  check(parsed.revision !== '', `редакция прочитана: «${parsed.revision}»`);
  check(parsed.published !== null, `дата публикации прочитана: ${parsed.published}`);

  console.log(`  Редакция: «${parsed.revision}», размещено: ${parsed.published}`);
  console.log('  Состав:', JSON.stringify(parsed.counts, null, 0));
  parsed.files.forEach((f, i) => console.log(`    ${i + 1}. [${f.kind}] ${f.name}`));

  const issues = validateDocumentsPage(parsed);
  console.log(`  Замечаний: ${issues.length}${issues.length ? ' — ' + issues.join('; ') : ''}`);
  check(!issues.some((i) => /не найдено ни одного файла/.test(i)),
    'страница не выглядит как тихий отказ');
}

section('Назначение файлов распознаётся по имени');
const kinds = parseDocumentsPage(fs.readFileSync(path.join(FIXTURES, docsFiles[0]), 'utf8'))
  .files.map((f) => f.kind);
check(kinds.includes('техническое задание'), 'техническое задание опознано');
check(kinds.includes('спецификация'), 'спецификация опознана');
check(kinds.includes('проект договора'), 'проект договора опознан');
check(kinds.includes('документация'), 'документация о закупке опознана');

section('Отбор документов для модели');
const all = parseDocumentsPage(fs.readFileSync(path.join(FIXTURES, docsFiles[0]), 'utf8')).files;
const { selected, skipped } = selectForExtraction(all, 4);
check(selected.length === 4, `отобрано ровно 4 документа (${selected.length})`);
// Порядок изменён 13.10.2026 по требованию владельца: «тз и документация
// тендера — приоритет». Раньше первой шла «документация», и при пределе
// отбора техническое задание могло в него не попасть.
check(selected[0].kind === 'техническое задание',
  `первым идёт техническое задание (${selected[0].kind})`);
check(selected.some((f) => f.kind === 'документация'),
  'документация о закупке в отбор попала');
check(selected.some((f) => f.kind === 'техническое задание') && selected.some((f) => f.kind === 'спецификация'),
  'техзадание и спецификация попали в отбор — именно там позиции лота');
check(!selected.some((f) => f.kind === 'форма заявки'),
  'бланк заявки не отправляется в модель — условий в нём нет, а токены он стоит');
check(skipped.every((s) => s.reason), 'у каждого отброшенного файла названа причина');
console.log('  Отобрано:');
selected.forEach((f) => console.log(`    [${f.kind}] ${f.name}`));
console.log('  Пропущено:');
skipped.forEach((s) => console.log(`    ${s.name} — ${s.reason}`));

section('Особенности 44-ФЗ');
const f44 = docsFiles.find((f) => f.startsWith('docs-fz44-'));
if (!f44) {
  console.log('  ! страница 44-ФЗ не собрана, раздел пропущен');
} else {
  const p44 = parseDocumentsPage(fs.readFileSync(path.join(FIXTURES, f44), 'utf8'));
  const kinds44 = p44.files.map((x) => x.kind);

  // У 44-ФЗ роль техзадания играет «Описание объекта закупки» — там позиции лота.
  check(kinds44.includes('описание объекта закупки'),
    '«Описание объекта закупки» опознано, а не свалено в «прочее»');
  const desc = p44.files.find((x) => x.kind === 'описание объекта закупки');
  check(desc && desc.ext === 'xlsx',
    `тип определён, несмотря на точку в имени файла (${desc ? desc.ext : '—'})`);

  // Типовой бланк портала, приложенный почти ко всем закупкам 44-ФЗ.
  check(kinds44.includes('инструкция по заполнению'),
    'типовая инструкция портала опознана и не принята за документацию закупки');
  const sel44 = selectForExtraction(p44.files, 4);
  check(!sel44.selected.some((x) => x.kind === 'инструкция по заполнению'),
    'типовая инструкция не отправляется в модель');
  check(sel44.skipped.some((s) => /типовая инструкция/.test(s.reason)),
    'причина пропуска названа, решение не невидимое');
  check(sel44.selected.some((x) => x.kind === 'описание объекта закупки'),
    'описание объекта закупки попало в отбор — там позиции лота');

  // На странице несколько блоков-событий. Сведения должны относиться к тому,
  // в котором лежат файлы, а не к первому попавшемуся на странице.
  check(p44.published === '2026-09-19',
    `дата взята из блока с файлами, а не из соседнего события (${p44.published})`);
  check(p44.latestEvent === '2026-09-21',
    `более позднее событие замечено (${p44.latestEvent})`);
  check(validateDocumentsPage(p44).some((i) => /условия могли измениться после публикации/.test(i)),
    'предупреждение: закупку меняли уже после публикации этих файлов');
}

section('Сведения берутся из блока с файлами, а не с начала страницы');
// Два события подряд: первое без файлов и с чужой датой, второе — с файлами.
const twoEvents = `
<div class="section__attrib">Размещено</div><div class="section__value">01.01.2026</div>
<div class="section__attrib">Редакция</div><div class="section__value">Недействующая</div>
<div class="section__attrib">Размещено</div><div class="section__value">05.02.2026</div>
<div class="section__attrib">Редакция</div><div class="section__value">Действующая</div>
<a href="https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=Z1">Документация о закупке.docx</a>`;
const te = parseDocumentsPage(twoEvents);
check(te.published === '2026-02-05', `взята дата блока с файлами (${te.published})`);
check(te.revision === 'Действующая', `взята редакция блока с файлами («${te.revision}»)`);
check(te.latestEvent === null, 'более поздних событий нет — ложной тревоги не будет');

section('ЛОВУШКА: имя из подсказки, а не из текста ссылки');
// Тот самый случай, на котором споткнулся наивный шаблон при разведке:
// внутри data-tooltip лежит HTML со своими угловыми скобками.
const tricky = `
<img alt="Microsoft Word Document" src="/epz/static/img/icons/type/doc.svg" data-tooltip="<span class='custom-tooltiptext'>Microsoft Word Document</span>"/>
<a href="https://zakupki.gov.ru/223/filestore/public/1.0/download/fz223/file.html?uid=AAA"
   data-tooltip='<span class="custom-tooltiptext">Техническое задание.doc</span>'>
   Техническое задание.doc
</a>`;
const t = parseDocumentsPage(tricky);
check(t.files.length === 1, `найден ровно один файл (${t.files.length})`);
check(t.files[0].name === 'Техническое задание.doc', `имя разобрано начисто: «${t.files[0].name}»`);
check(t.files[0].kind === 'техническое задание', 'назначение определено');
check(t.files[0].iconType === 'doc', 'тип взят из иконки');

section('Имя пустое — тип берётся из иконки');
const noName = `
<img src="/epz/static/img/icons/type/pdf.svg"/>
<a href="https://zakupki.gov.ru/223/filestore/public/1.0/download/fz223/file.html?uid=BBB"></a>`;
const nn = parseDocumentsPage(noName);
check(nn.files.length === 1 && nn.files[0].ext === 'pdf',
  'файл не потерян, тип определён по иконке');
check(validateDocumentsPage(nn).some((i) => /не распознано имя/.test(i)), 'отсутствие имени помечено');

section('ТИХИЙ ОТКАЗ: файлов нет вовсе');
const emptyPage = parseDocumentsPage('<html><body><div>Документы отсутствуют</div></body></html>');
check(emptyPage.files.length === 0, 'список пуст');
const emptyIssues = validateDocumentsPage(emptyPage);
check(emptyIssues.some((i) => /не найдено ни одного файла/.test(i)), 'пустая страница помечена как проблема');
check(emptyIssues.some((i) => /алерт/.test(i)),
  'сказано прямо: нужен алерт владельцу, а не молчание клиенту');

section('Архивы и подписи');
const mixed = parseDocumentsPage(`
<a href="https://zakupki.gov.ru/223/filestore/public/1.0/download/fz223/file.html?uid=C1">Документация.rar</a>
<a href="https://zakupki.gov.ru/223/filestore/public/1.0/download/fz223/file.html?uid=C2">Документация.doc.sig</a>
<a href="https://zakupki.gov.ru/223/filestore/public/1.0/download/fz223/file.html?uid=C3">Техническое задание.docx</a>`);
check(mixed.files.length === 3, 'все три файла разобраны');
check(validateDocumentsPage(mixed).some((i) => /архив/.test(i)), 'архив помечен: содержимое недоступно');
const pick = selectForExtraction(mixed.files, 4);
// С 20.10.2026 RAR и 7z распаковывает конвертер — архив идёт в разбор.
check(pick.selected.length === 2 && pick.selected.some((f) => f.ext === 'docx') && pick.selected.some((f) => f.ext === 'rar'),
  'в разбор идут документ и архив RAR (его распакует конвертер), подпись — нет');
check(pick.skipped.some((s) => /подпись/.test(s.reason)),
  'причина пропуска подписи названа по-человечески');

section('Читаются все документы, кроме служебных (владелец 28.10.2026)');
{
  const ссылка = (uid, имя) => `<a href="https://zakupki.gov.ru/223/filestore/public/1.0/download/fz223/file.html?uid=${uid}">${имя}</a>`;
  const имена = ['Техническое задание.docx', 'Обоснование НМЦК.xlsx', 'Проект договора.docx', 'Извещение.docx',
    'Приложение 1.docx', 'Приложение 2.xlsx', 'Приложение 3.docx', 'Ведомость объемов.xlsx', 'Форма заявки.docx',
    'Критерии оценки.docx', 'Инструкция по заполнению заявки.docx'];
  const стр = parseDocumentsPage(имена.map((и, i) => ссылка('D' + i, и)).join('\n'));
  const от = selectForExtraction(стр.files, 25);
  check(от.selected.length === 8, `8 рабочих документов из 11 - все в разбор (взято ${от.selected.length})`);
  check(['Форма заявки.docx', 'Критерии оценки.docx', 'Инструкция по заполнению заявки.docx']
    .every((и) => от.skipped.some((s) => s.name === и)), 'форма заявки, критерии и инструкция пропущены с причиной');
}

section('Устаревшая редакция документации');
// ЛОВУШКА: слово «Недействующая» содержит в себе «действующ». Проверка
// вхождением пропустила бы устаревшую документацию как нормальную.
const page = (revision) => ({
  files: [{ name: 'Документация.doc', ext: 'doc', uid: 'x' }],
  revision,
  published: null,
  counts: {}
});
check(validateDocumentsPage(page('Недействующая')).some((i) => /не действующая/.test(i)),
  'редакция «Недействующая» помечена — условия могли измениться');
check(validateDocumentsPage(page('Действующая')).length === 0,
  'действующая редакция замечаний не вызывает');

section('Битый вход');
check(parseDocumentsPage('').files.length === 0, 'пустая строка не ломает разбор');
check(parseDocumentsPage(null).files.length === 0, 'null не ломает разбор');
check(parseDocumentsPage('<a href="/epz/order/notice/notice223/document/signview/listModal.html?x=1">ЭП</a>')
  .files.length === 0, 'страница с одними подписями даёт пустой список, а не мусор');

console.log(`\n${failures === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : 'ПРОВАЛЕНО ПРОВЕРОК: ' + failures}`);
process.exit(failures === 0 ? 0 : 1);
