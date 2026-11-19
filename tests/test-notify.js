/**
 * Тесты формирования уведомлений.
 * Запуск: node tests/test-notify.js
 *
 * Здесь проверяется не вёрстка, а обещания, которые уведомление даёт клиенту:
 * что расчёт назван прикидкой, что неподтверждённое помечено, что система
 * нигде не заявляет о действиях от его имени, и что сообщение физически
 * дойдёт — не оборвётся по длине и не сломается на спецсимволах.
 */
const {
  buildNotification, buildTelegram, buildEmail, buildSheetRow,
  buildDigest, buildOwnerAlert, collectFacts, groupDigits,
  SHEET_COLUMNS, TELEGRAM_LIMIT, КНОПКА_РАСЧЁТА, NBSP
} = require('../src/notify');
const { scoreTender } = require('../src/scoring');

let failures = 0;
const check = (ok, message) => {
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${message}`);
  if (!ok) failures++;
};
const section = (name) => console.log(`\n=== ${name} ===`);

const NOW = new Date('2026-09-26T12:00:00Z');

const tender = (over = {}) => ({
  number: '0318300173926000268',
  law: '44-ФЗ Электронный аукцион',
  status: 'Подача заявок',
  object: 'Поставка бумаги для офисной техники',
  orgName: 'ГБУЗ «Городская клиническая больница им. Н.И. Пирогова»',
  orgRole: 'заказчик',
  price: 1200000,
  deadline: '2026-10-20',
  url: 'https://zakupki.gov.ru/epz/order/notice/ea20/view/common-info.html?regNumber=0318300173926000268',
  ...over
});

const scored = (t, cfg = {}) => scoreTender(t, { expectedDiscount: 0.10, costRatio: 0.70, ...cfg }, NOW);
const item = (over = {}) => {
  const t = over.tender || tender();
  return { tender: t, scored: scored(t), ...over };
};

section('Сообщение в Telegram доходит и читается');
const tg = buildTelegram(item(), NOW);
check(tg.text.length <= TELEGRAM_LIMIT, `длина в пределах лимита (${tg.text.length} из ${TELEGRAM_LIMIT})`);
check(tg.parseMode === 'HTML', 'режим разметки указан явно, а не выбирается обвязкой наугад');
console.log('  --- как это выглядит ---');
tg.text.split('\n').forEach((l) => console.log('  | ' + l));

section('Главное видно сразу');
check(/Поставка бумаги/.test(tg.text), 'объект закупки есть');
check(tg.text.includes(`1${NBSP}200${NBSP}000${NBSP}₽`), 'НМЦК есть и отформатирована по-русски');
check(/20\.10\.2026/.test(tg.text), 'срок подачи в привычном виде');
check(/осталось 24 дн/.test(tg.text), 'сказано, сколько дней осталось');
check(/Пирогова/.test(tg.text), 'заказчик назван');
check(tg.text.includes('zakupki.gov.ru'), 'ссылка на закупку есть');

section('Формат числа не зависит от сборки Node');
// toLocaleString('ru-RU') на урезанной сборке Node (частой на дешёвых VPS)
// печатает «1,200,000» по-английски. Тест разработчика при этом проходит,
// а клиент получает уведомление с чужим форматом цены. Разбивка своя.
check(groupDigits(1200000) === `1${NBSP}200${NBSP}000`, 'миллион разбит по разрядам');
check(groupDigits(999) === '999', 'три цифры не разбиваются');
check(groupDigits(1000) === `1${NBSP}000`, 'ровно тысяча разбивается');
check(groupDigits(-52041) === `-52${NBSP}041`, 'отрицательное число со знаком');
check(groupDigits(0) === '0', 'ноль печатается как ноль');
check(!/,/.test(groupDigits(1234567)), 'запятых как разделителей разрядов нет ни при какой локали');

section('ЧЕСТНОСТЬ: прибыль не показывается, пока её неоткуда взять');
// ИЗМЕНЕНО 03.10.2026. Раньше здесь печаталась «прикидка по деньгам»
// из scoring.js. Выяснилось, что она бесполезна: себестоимость считалась
// как доля от НМЦК, поэтому маржа выходила ОДИНАКОВОЙ у всех тендеров —
// 8,77%. Число, которое не различает закупки, хуже отсутствия числа:
// оно выглядит расчётом и им не является.
//
// Настоящая маржа считается после разбора документации и поиска поставщиков,
// а это платный шаг по кнопке. До него прибыль не показывается вовсе.
check(!/прибыль ≈/.test(tg.text),
  'прибыль не печатается: до разбора документации её неоткуда взять');
check(/[Пп]онадобится из оборота/.test(tg.text),
  'потребность в деньгах показана — она зависит от НМЦК и обеспечений, а не от себестоимости');

section('ОРИЕНТИР ПО НАЦЕНКЕ КЛИЕНТА — его собственное число');
// Клиент знает свою обычную наценку по категории лучше всех. Ориентир по ней
// честен: это не наша оценка. Для решения «стоит ли тратить платный расчёт»
// этого достаточно.
const сНаценкой = buildTelegram({ ...item(), typicalMarginPct: 20 }, NOW);
check(/обычной марже 20%/.test(сНаценкой.text), 'наценка клиента названа прямо');
check(/не расчёт/.test(сНаценкой.text), 'помечено, что это не расчёт');
check(/после разбора документации/.test(сНаценкой.text),
  'сказано, когда появится точная цифра');

section('КНОПКА «ПОСЧИТАТЬ» — расчёт платный и запускается человеком');
// Разбор с поиском поставщиков стоит около 70 ₽ за тендер. Считать все
// найденные закупки — работа в убыток втрое при плате 15 000 с клиента.
check(tg.keyboard && Array.isArray(tg.keyboard.inline_keyboard),
  'к сообщению приложена кнопка');
const кнопка = tg.keyboard.inline_keyboard[0][0];
// Сверяемся с константой, а не с текстом: надпись объявлена в одном месте
// (КНОПКА_РАСЧЁТА в src/notify.js), и проверка не должна требовать правки
// при каждом изменении формулировки — только при изменении смысла.
check(кнопка.text === КНОПКА_РАСЧЁТА, `надпись взята из константы: «${кнопка.text}»`);
check(/тендер/i.test(кнопка.text),
  'кнопка выбирает тендер для разбора, а не продаёт отдельную услугу');
check(кнопка.callback_data.startsWith('смета:'), 'в ответе придёт признак действия');
check(кнопка.callback_data.length <= 64,
  `длина ответа ${кнопка.callback_data.length} байт — Telegram больше 64 не принимает`);
check(кнопка.callback_data.includes(item().tender.number), 'номер закупки передан');
const mail = buildEmail(item(), NOW);
check(/не расчёт маржи/.test(mail.body), 'в письме то же предупреждение');
check(/не измерено/.test(mail.body), 'сказано, что допущение о падении цены не измерено');

section('Система не заявляет о действиях от имени клиента');
const forbidden = /(подадим|подаём|подать заявку|отправим заявку|сделаем ставку|подписываем)/i;
check(!forbidden.test(tg.text), 'в Telegram нет обещаний подать заявку');
check(!forbidden.test(mail.body), 'в письме нет обещаний подать заявку');
check(/Заявку система не подаёт/.test(mail.body), 'в письме сказано прямо, что заявку подаёт человек');

section('Изменения в известном тендере выделены');
const changed = buildTelegram(item({
  changes: [
    { field: 'deadline', label: 'срок подачи', from: '2026-10-20', to: '2026-10-10' },
    { field: 'price', label: 'НМЦК', from: 1200000, to: 1100000 }
  ]
}), NOW);
check(/Изменения в уже известном тендере/.test(changed.text), 'блок изменений есть');
check(/срок подачи.*2026-10-20.*2026-10-10/s.test(changed.text), 'показано старое и новое значение срока');
const changedMail = buildEmail(item({ changes: [{ label: 'срок подачи', from: '2026-10-20', to: '2026-10-10' }] }), NOW);
check(/^Изменение:/.test(changedMail.subject), `тема письма отличает изменение от нового тендера: «${changedMail.subject.slice(0, 40)}…»`);

section('Неподтверждённое помечено');
const verified = {
  confidence: 'требует проверки',
  conflicts: [{ field: 'НМЦК', fromCard: 1200000, fromDocs: 1250000, note: '' }],
  issues: ['обеспечение заявки: цитата в документе не найдена — доверять нельзя'],
  fields: {}
};
const uncertain = buildTelegram(item({ verified }), NOW);
check(/требует проверки/.test(uncertain.text), 'уверенность разбора названа');
check(/в карточке 1200000, в документации 1250000/.test(uncertain.text),
  'расхождение показано обоими числами, без выбора наугад');
check(/Проверить вручную/.test(uncertain.text), 'есть отдельный список того, что проверить');

section('Срок из документации перекрывает карточку, если он раньше');
const earlier = collectFacts(item({
  verified: {
    confidence: 'высокая', conflicts: [], issues: [],
    fields: { deadline: { value: '2026-10-15', grounded: true, confidence: 'высокая' } }
  }
}), NOW);
check(earlier.deadline === '2026-10-15', `взят более ранний срок (${earlier.deadline})`);
check(earlier.deadlineSource === 'документация закупки', 'источник срока указан явно');

const later = collectFacts(item({
  verified: {
    confidence: 'высокая', conflicts: [], issues: [],
    fields: { deadline: { value: '2026-10-25', grounded: true, confidence: 'высокая' } }
  }
}), NOW);
check(later.deadline === '2026-10-20', 'более поздний срок из документации не перекрывает карточку');

const ungrounded = collectFacts(item({
  verified: {
    confidence: 'средняя', conflicts: [], issues: [],
    fields: { deadline: { value: '2026-10-01', grounded: false, confidence: 'высокая' } }
  }
}), NOW);
check(ungrounded.deadline === '2026-10-20',
  'неподтверждённый цитатой срок не подменяет карточку, даже будучи более ранним');

section('Спецсимволы не ломают отправку');
const tricky = buildTelegram(item({
  tender: tender({
    object: 'Поставка «уголков» <усиленных> & крепежа',
    orgName: 'ООО "Ромашка" <офис №1>'
  })
}), NOW);
check(!/<(?!\/?(b|i|a|code)\b)[a-z]/i.test(tricky.text.replace(/&lt;|&gt;/g, '')),
  'угловые скобки из данных экранированы, разметка не сломана');
check(/&amp;/.test(tricky.text), 'амперсанд экранирован');
check(/&lt;усиленных&gt;/.test(tricky.text), 'текст в скобках сохранён, а не вырезан');

section('Длинное сообщение обрезается аккуратно');
const longItem = item({
  tender: tender({ object: 'Поставка ' + 'очень длинного наименования товара '.repeat(200) })
});
const long = buildTelegram(longItem, NOW);
check(long.text.length <= TELEGRAM_LIMIT, `уложились в лимит (${long.text.length})`);
check(/сообщение сокращено/.test(long.text), 'сказано, что сообщение сокращено');
check(!/&[a-z]+$/.test(long.text), 'обрезка не разорвала экранированную последовательность');

section('Строка таблицы');
const row = buildSheetRow(item(), NOW);
check(row.length === SHEET_COLUMNS.length, `столбцов ${row.length}, как в заголовке (${SHEET_COLUMNS.length})`);
check(typeof row[SHEET_COLUMNS.indexOf('НМЦК')] === 'number',
  'НМЦК числом, чтобы формулы клиента работали');
check(row[SHEET_COLUMNS.indexOf('Срок подачи')] === '2026-10-20',
  'дата в сортируемом виде, а не «20.10.2026»');
check(row.every((c) => c !== undefined && c !== null), 'пустых ячеек-дыр нет');
console.log('  ' + SHEET_COLUMNS.map((c, i) => `${c}=${String(row[i]).slice(0, 18)}`).join(' | ').slice(0, 300));

section('Нераспознанная цена не ломает уведомление');
const noPrice = buildNotification(item({ tender: tender({ price: null }) }), NOW);
check(!/undefined|NaN|null/.test(noPrice.telegram.text), 'в сообщении нет технического мусора');
check(/—/.test(noPrice.telegram.text), 'вместо цены стоит прочерк, а не выдуманное число');
check(noPrice.telegram.text.length > 50, 'тендер всё равно уходит человеку, а не пропадает');

section('Сводка, когда тендеров много');
const many = [];
for (let i = 0; i < 25; i++) {
  many.push(item({ tender: tender({ number: String(i).padStart(19, '0'), price: 100000 * (i + 1) }) }));
}
const digest = buildDigest(many, NOW);
check(digest.text.length <= TELEGRAM_LIMIT, `сводка в пределах лимита (${digest.text.length})`);
check(/Новых тендеров: 25/.test(digest.text), 'названо общее число');
check(/и ещё \d+, в сообщении не показаны/.test(digest.text) && !/в таблице/.test(digest.text),
  'сказано, сколько не показано, и нет ссылки на несуществующую таблицу');

section('Алерт о сбое уходит владельцу, а не клиенту');
const alert = buildOwnerAlert(
  'парсер не нашёл ни одной карточки',
  'Страница поиска получена (359 КБ), но карточек в разметке 0. Похоже на смену разметки портала.',
  { клиент: 'ООО Ромашка', запрос: 'бумага' },
  NOW
);
check(alert.audience === 'владелец сервиса', 'адресат указан явно');
check(/СБОЙ СЕРВИСА/.test(alert.text), 'сообщение сразу опознаётся как авария');
check(/Похоже на смену разметки/.test(alert.text), 'описана суть, а не код ошибки');
check(/клиент: ООО Ромашка/.test(alert.text), 'контекст приложен');
check(alert.audit && alert.audit.at === NOW.toISOString(), 'алерт попадает в аудит-лог с меткой времени');

section('Аудит-лог');
const full = buildNotification(item({ changes: [{ label: 'НМЦК', from: 1, to: 2 }] }), NOW);
check(full.audit.at === NOW.toISOString(), 'метка времени есть');
check(full.audit.number === '0318300173926000268', 'номер тендера записан');
check(full.audit.kind === 'изменение', 'вид уведомления записан');
check(typeof full.audit.checksCount === 'number', 'число замечаний записано');

section('Три канала не расходятся в содержании');
const both = buildNotification(item({ verified }), NOW);
check(/требует проверки/.test(both.telegram.text) &&
      /требует проверки/.test(both.email.body) &&
      both.sheetRow.includes('требует проверки'),
  'уверенность разбора одинакова во всех трёх каналах');

section('Битый вход');
check(buildTelegram({}, NOW).text.length > 0, 'пустой объект не роняет формирование');
check(!/undefined/.test(buildTelegram({}, NOW).text), 'и не печатает undefined');
check(buildSheetRow({}, NOW).length === SHEET_COLUMNS.length, 'строка таблицы всё равно нужной ширины');

section('Строка о разборе документации — по факту расчёта, 16.10.2026');
const сРазбором = buildTelegram({ tender: { number: '1', price: 100000 }, scored: { priority: 'средний' },
  разбор: 'разобрана кодом: файлов 3, позиций 4, ТЗ прочитано' }, NOW).text;
check(/разобрана кодом/.test(сРазбором) && !/не разбиралась/.test(сРазбором),
  'когда документация разобрана, сообщение так и говорит');
// Отрицательный контроль: без разбора прежняя честная строка остаётся.
check(/не разбиралась/.test(buildTelegram({ tender: { number: '1' }, scored: {} }, NOW).text),
  'без разбора сказано, что не разбиралась');

console.log(`\n${failures === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : 'ПРОВАЛЕНО ПРОВЕРОК: ' + failures}`);
process.exit(failures === 0 ? 0 : 1);
