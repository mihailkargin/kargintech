/**
 * Тесты фильтрации и дедупликации.
 * Запуск: node tests/test-logic.js
 */
const fs = require('fs');
const path = require('path');
const { parseSearchPage } = require('../src/parser');
const { matchesFilters, applyFilters } = require('../src/filter');
const { diffAgainstState } = require('../src/dedup');

let failures = 0;
const check = (ok, message) => {
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${message}`);
  if (!ok) failures++;
};
const section = (name) => console.log(`\n=== ${name} ===`);

const tender = (over = {}) => ({
  number: '0318300173926000268',
  law: '44-ФЗ Электронный аукцион',
  status: 'Подача заявок',
  object: 'Поставка бумаги для офисной техники',
  orgName: 'ГБУЗ Городская больница',
  orgRole: 'заказчик',
  price: 110700,
  published: '2026-09-19',
  deadline: '2026-09-28',
  url: 'https://zakupki.gov.ru/x',
  docsUrl: 'https://zakupki.gov.ru/y',
  ...over
});

// ---------------------------------------------------------------- ФИЛЬТР

section('Фильтр: ключевые слова');
check(matchesFilters(tender(), { keywords: ['бумаг'] }).passed,
  'основа слова ловит словоформу («бумаг» → «бумаги»)');
check(matchesFilters(tender(), { keywords: ['БУМАГ'] }).passed,
  'регистр не важен');
check(matchesFilters(tender({ object: 'Поставка бумаги' }), { keywords: ['бумаг'] }).matched.length === 1,
  'сработавшее слово возвращается для журнала');
const noMatch = matchesFilters(tender(), { keywords: ['щебень'] });
check(!noMatch.passed && noMatch.reasons.some(r => /ключевым словам/.test(r)),
  'без совпадения — отсев с указанием причины');
check(matchesFilters(tender({ object: '', orgName: 'Бумажная фабрика' }), { keywords: ['бумаж'] }).passed,
  'объекта закупки нет (электронный магазин) - совпадение ищется в названии организации');
check(!matchesFilters(tender({ object: '', orgName: 'ООО СКС' }), { keywords: ['скс'] }).passed
  && !matchesFilters(tender({ object: '', orgName: 'ООО СКУД' }), { keywords: ['скуд'] }).passed,
  'короткая аббревиатура в названии организации не заменяет предмет закупки');
check(matchesFilters(tender({ object: 'Монтаж СКС', orgName: 'ООО Другое' }), { keywords: ['скс'] }).passed,
  'та же аббревиатура в предмете закупки работает');
check(!matchesFilters(tender({ object: 'Поставка топлива', orgName: 'Пожарная часть №5' }), { keywords: ['пожарн'] }).passed,
  'объект есть - название заказчика словом не считается (топливо пожарной части - не пожарное оборудование)');
check(!matchesFilters(tender({ object: 'Поставка продуктов для столовой' }), { keywords: ['стол'] }).passed
  && matchesFilters(tender({ object: 'Поставка столов ученических' }), { keywords: ['стол'] }).passed,
  'короткая основа: «столов» - да, «столовой» - нет');
check(matchesFilters(tender({ object: 'Поставка бумаги офисной' }), { keywords: ['бума'] }).passed
  && matchesFilters(tender({ object: 'Поставка бланочной продукции' }), { keywords: ['блан'] }).passed,
  'нарочно обрезанные короткие основы работают: «бума» - бумага, «блан» - бланочная (сохранённые настройки клиентов)');
{
  const ф = { keywords: ['стол'], phrases: ['столы офисные'] };
  const по = (o) => matchesFilters(tender({ object: o }), ф).passed;
  check(по('Поставка столов ученических') && по('Поставка стола') && !по('Поставка столбов освещения')
    && !по('Вакцина для профилактики столбняка') && !по('Услуги для гостей столицы'),
    '«стол» из фразы «столы офисные» - только окончания слова: столбы, столбняк, столица не проходят');
  check(matchesFilters(tender({ object: 'Поставка бумаги офисной' }), { keywords: ['бума'], phrases: ['бумага для офисной техники'] }).passed,
    '«бума» из фразы «бумага» - обрезанная основа, бумага проходит');
}
check(!matchesFilters(tender({ object: 'Материалы для ремонта водопровода' }), { keywords: ['провод'] }).passed
  && matchesFilters(tender({ object: 'Кабельно-проводниковая продукция' }), { keywords: ['провод'] }).passed,
  'основа - в начале слова: «водопровод» - нет, «кабельно-проводниковая» - да');

section('Фильтр: стоп-слова');
const medical = tender({ object: 'Поставка изделий медицинского назначения (бумага для коагулометра)' });
const verdict = matchesFilters(medical, { keywords: ['бумаг'], stopWords: ['медицинск'] });
check(!verdict.passed && verdict.reasons.some(r => /стоп-слова/.test(r)),
  'стоп-слово перевешивает совпадение по ключевому слову');
check(matchesFilters(tender(), { keywords: ['бумаг'], stopWords: ['медицинск'] }).passed,
  'обычный тендер стоп-словом не задет');
check(!matchesFilters(tender({ object: 'Услуги по пультовой охране' }), { stopWords: ['пультовая охрана'] }).passed,
  'стоп-фраза ловит другие падежи: «пультовой охраны»');
check(!matchesFilters(tender({ object: 'Оказание охранных услуг' }), { stopWords: ['охранные услуги'] }).passed,
  '«охранные услуги» ловит «охранных услуг»');
check(matchesFilters(tender({ object: 'Монтаж пультовой сигнализации' }), { stopWords: ['пультовая охрана'] }).passed,
  'стоп-фраза не срабатывает без одного из слов');
{
  const стоп = require('../site/categories').стопСловаКатегорий(['lowcurrent']);
  const объект = 'Оказание услуг по охране путем реагирования на сообщения о срабатывании тревожной сигнализации';
  check(matchesFilters(tender({ object: объект }), { keywords: ['тревожн'] }).passed
    && !matchesFilters(tender({ object: объект }), { keywords: ['тревожн'], stopWords: стоп }).passed,
    'слаботочная лента исключает физическую охрану с реагированием на тревогу');
  check(matchesFilters(tender({ object: 'Техническое обслуживание системы охранной сигнализации' }), { keywords: ['охранн'], stopWords: стоп }).passed,
    'исключение реагирования не отрезает техническое обслуживание сигнализации');
}
check(matchesFilters(tender({ object: 'Разработка системы' }), { stopWords: ['работ по'] }).passed,
  '«работ по» не срабатывает внутри «разработка»');

section('Фильтр: цена');
check(!matchesFilters(tender({ price: 5000 }), { minPrice: 50000 }).passed,
  'ниже нижней границы — отсев');
check(!matchesFilters(tender({ price: 9000000 }), { maxPrice: 5000000 }).passed,
  'выше верхней границы — отсев');
const unparsedPrice = matchesFilters(tender({ price: null }), { minPrice: 50000 });
check(unparsedPrice.passed && unparsedPrice.needsReview,
  'нераспознанная НМЦК не отсеивает тендер, а помечает его на проверку');

section('Фильтр: закон, статус, срок');
check(!matchesFilters(tender(), { laws: ['223-ФЗ'] }).passed, 'фильтр по закону работает');
check(matchesFilters(tender(), { laws: ['44-ФЗ'] }).passed, 'нужный закон проходит');
check(!matchesFilters(tender({ status: 'Работа комиссии' }), { statuses: ['Подача заявок'] }).passed,
  'закрытый для подачи тендер отсеивается');
check(!matchesFilters(tender({ deadline: null }), { requireDeadline: true }).passed,
  'при требовании срока карточка без срока отсеивается');
check(matchesFilters(tender({ deadline: null }), {}).passed,
  'без такого требования карточка без срока проходит');

section('Фильтр: отсеянные не теряются');
const { passed, rejected } = applyFilters([tender(), tender({ number: '1', object: 'Поставка щебня' })], { keywords: ['бумаг'] });
check(passed.length === 1 && rejected.length === 1, 'разделение на прошедшие и отсеянные');
check(rejected[0].reasons.length > 0 && rejected[0].object === 'Поставка щебня',
  'у отсеянного сохранены предмет закупки и причина — есть что показать в журнале');

section('Фильтр: на реальной выдаче');
const html = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'search-bumaga-2026-09-19.html'), 'utf8');
const real = parseSearchPage(html);
const paperSupplier = { keywords: ['бумаг'], stopWords: ['медицинск', 'реактив'], minPrice: 30000 };
const result = applyFilters(real, paperSupplier);
console.log(`  Из ${real.length} карточек прошло ${result.passed.length}, отсеяно ${result.rejected.length}`);
result.rejected.forEach(r => console.log(`    отсев ${r.number}: ${r.reasons.join('; ')}`));
check(result.passed.length + result.rejected.length === real.length, 'ни одна карточка не потерялась');
check(result.rejected.some(r => /медицинск/.test(r.reasons.join())),
  'медицинская бумага отсеяна стоп-словом');
check(result.passed.every(t => t.price >= 30000 || t.needsReview), 'прошедшие удовлетворяют порогу цены');

// ------------------------------------------------------------ ДЕДУПЛИКАЦИЯ

const NOW = new Date('2026-09-19T12:00:00Z');

section('Дедупликация: первый и повторный прогон');
const first = diffAgainstState(real, {}, { now: NOW });
check(first.fresh.length === real.length, 'на пустом состоянии все тендеры новые');
check(Object.keys(first.nextState).length === real.length, 'состояние заполнено');

const second = diffAgainstState(real, first.nextState, { now: NOW });
check(second.fresh.length === 0, 'повторный прогон не даёт новых');
check(second.updated.length === 0, 'повторный прогон не даёт изменённых');
check(second.unchanged.length === real.length, 'все тендеры опознаны как уже виденные');

section('Дедупликация: изменения в известном тендере');
const moved = real.map((t, i) => (i === 0 ? { ...t, deadline: '2026-10-15' } : t));
const afterMove = diffAgainstState(moved, first.nextState, { now: NOW });
check(afterMove.updated.length === 1, 'сдвиг срока подачи распознан как изменение');
check(afterMove.updated[0].changes.some(c => c.field === 'deadline' && c.to === '2026-10-15'),
  'в изменении указаны поле, старое и новое значение');

const repriced = real.map((t, i) => (i === 1 ? { ...t, price: t.price + 1000 } : t));
check(diffAgainstState(repriced, first.nextState, { now: NOW }).updated.length === 1,
  'изменение НМЦК распознано');

const closed = real.map((t, i) => (i === 2 ? { ...t, status: 'Работа комиссии' } : t));
check(diffAgainstState(closed, first.nextState, { now: NOW }).updated.length === 1,
  'смена статуса распознана');

section('Дедупликация: новый тендер рядом с известными');
const withNew = [...real, tender({ number: '9999999999999999999', object: 'Поставка бумаги, новый лот' })];
const mixed = diffAgainstState(withNew, first.nextState, { now: NOW });
check(mixed.fresh.length === 1 && mixed.fresh[0].number === '9999999999999999999',
  'новый выделен, старые не продублированы');

section('Дедупликация: сохранение и чистка состояния');
const later = new Date('2026-09-26T12:00:00Z');
const absent = diffAgainstState([], first.nextState, { now: later, keepDays: 60 });
check(Object.keys(absent.nextState).length === real.length,
  'тендер, пропавший из выдачи, НЕ забывается — иначе вернётся как новый');

const longAfter = new Date('2027-01-01T12:00:00Z');
const pruned = diffAgainstState([], first.nextState, { now: longAfter, keepDays: 60 });
check(Object.keys(pruned.nextState).length === 0 && pruned.prunedCount === real.length,
  'давно просроченные тендеры вычищены из состояния');

const again = diffAgainstState(real, first.nextState, { now: later });
check(again.unchanged.length === real.length &&
      Object.values(again.nextState).every(e => e.firstSeen === '2026-09-19'),
  'дата первого обнаружения сохраняется между прогонами');

// Тест «слаботочка» 20.10.2026: закупки у единственного поставщика шли клиенту.
{
  const ед = matchesFilters({ object: 'Поставка силового кабеля', orgName: 'АО Теплосеть', price: 1560000,
    law: '223-ФЗ Закупка у единственного поставщика (подрядчика, исполнителя) (до 01.07.18)' }, { keywords: ['кабел'] });
  check(!ед.passed && ед.reasons.some((r) => /единственного поставщика/.test(r)), 'закупка у единственного поставщика отсекается всегда');
  const обычн = matchesFilters({ object: 'Поставка силового кабеля', orgName: 'АО Теплосеть', price: 1560000,
    law: '223-ФЗ Запрос котировок в электронной форме' }, { keywords: ['кабел'] });
  check(обычн.passed, 'запрос котировок с тем же объектом проходит');
}

console.log(`\n${failures === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : 'ПРОВАЛЕНО ПРОВЕРОК: ' + failures}`);
process.exit(failures === 0 ? 0 : 1);
