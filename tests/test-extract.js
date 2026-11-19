/**
 * Тесты извлечения условий из документации.
 * Запуск: node tests/test-extract.js
 *
 * Главное, что здесь проверяется, — что система НЕ верит модели на слово.
 * Каждое значение должно опираться на цитату, которая действительно есть в
 * документе; критичные числа должны сверяться с карточкой; невозможные
 * значения должны отлавливаться, даже если модель была в них уверена.
 */
const {
  buildExtractionRequest,
  parseExtraction,
  verifyExtraction,
  factualEconomics,
  explainExtraction,
  parseAmount,
  parseSecurity,
  bidSecurityLimit,
  CARD_FIELDS
} = require('../src/extract');
const { scoreTender } = require('../src/scoring');

let failures = 0;
const check = (ok, message) => {
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${message}`);
  if (!ok) failures++;
};
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;
const section = (name) => console.log(`\n=== ${name} ===`);

const NOW = new Date('2026-09-26T12:00:00Z');

const DOC = [
  'Извещение о проведении электронного аукциона.',
  'Начальная (максимальная) цена контракта: 1 200 000,00 руб.',
  'Дата и время окончания срока подачи заявок: 20.10.2026 09:00.',
  'Срок поставки товара: до 15.12.2026 включительно.',
  'Место поставки: г. Москва, склад заказчика.',
  'Размер обеспечения заявки на участие: 1% от начальной максимальной цены контракта.',
  'Размер обеспечения исполнения контракта: 5% от начальной максимальной цены контракта.',
  'За просрочку исполнения обязательств начисляется пеня в размере 1/300 ключевой ставки.',
  'Требования к участнику: соответствие статье 31 Федерального закона № 44-ФЗ.',
  'Оплата производится в течение 7 рабочих дней с даты подписания документа о приёмке.',
  'Позиция 1: Бумага для офисной техники А4, 500 упаковок.',
  'Позиция 2: Папка-регистратор 75 мм, 300 штук.'
].join('\n');

const TENDER = {
  number: '0318300173926000268',
  law: '44-ФЗ',
  object: 'Поставка канцелярских товаров',
  price: 1200000,
  deadline: '2026-10-20',
  status: 'Подача заявок'
};

/** Ответ модели, каким он должен быть в норме: цитаты взяты из DOC дословно. */
const goodAnswer = {
  deadline: { value: '2026-10-20', quote: 'Дата и время окончания срока подачи заявок: 20.10.2026 09:00.', confidence: 'высокая' },
  deliveryDeadline: { value: '2026-12-15', quote: 'Срок поставки товара: до 15.12.2026 включительно.', confidence: 'высокая' },
  deliveryPlace: { value: 'г. Москва, склад заказчика', quote: 'Место поставки: г. Москва, склад заказчика.', confidence: 'высокая' },
  nmck: { value: '1 200 000,00', quote: 'Начальная (максимальная) цена контракта: 1 200 000,00 руб.', confidence: 'высокая' },
  bidSecurity: { value: '1%', quote: 'Размер обеспечения заявки на участие: 1% от начальной максимальной цены контракта.', confidence: 'высокая' },
  contractSecurity: { value: '5%', quote: 'Размер обеспечения исполнения контракта: 5% от начальной максимальной цены контракта.', confidence: 'высокая' },
  penalties: { value: 'пеня 1/300 ключевой ставки', quote: 'За просрочку исполнения обязательств начисляется пеня в размере 1/300 ключевой ставки.', confidence: 'высокая' },
  requirements: { value: 'статья 31 44-ФЗ', quote: 'Требования к участнику: соответствие статье 31 Федерального закона № 44-ФЗ.', confidence: 'высокая' },
  paymentTerms: { value: '7 рабочих дней с даты приёмки', quote: 'Оплата производится в течение 7 рабочих дней с даты подписания документа о приёмке.', confidence: 'высокая' },
  items: [
    { name: 'Бумага для офисной техники А4', quantity: 500, unit: 'упак', quote: 'Позиция 1: Бумага для офисной техники А4, 500 упаковок.' },
    { name: 'Папка-регистратор 75 мм', quantity: 300, unit: 'шт', quote: 'Позиция 2: Папка-регистратор 75 мм, 300 штук.' }
  ]
};

const clone = (o) => JSON.parse(JSON.stringify(o));

section('Разбор сумм в разных написаниях');
check(parseAmount('1 200 000,00 руб.') === 1200000, 'русское написание с копейками');
check(parseAmount('12000.50') === 12000.5, 'машинное написание с точкой');
check(parseAmount('1.200.000') === 1200000, 'точки как разделители разрядов, а не дробная часть');
check(parseAmount(1200000) === 1200000, 'число передано числом');
check(parseAmount('не требуется') === 0, '«не требуется» это ноль, а не отсутствие данных');
check(parseAmount('не предусмотрено') === 0, '«не предусмотрено» с окончанием тоже ноль');
check(parseAmount('Не предусмотрена') === 0, 'форма женского рода распознаётся');
check(parseAmount('нет данных о сумме') === null || parseAmount('') === null, 'текст без числа даёт null');

section('Обеспечение: процент и сумма приводятся к одному виду');
const pct = parseSecurity('1% от НМЦК', 1200000);
check(near(pct.amount, 12000) && near(pct.ratio, 0.01), `1% от 1 200 000 это 12 000 (получено ${pct.amount})`);
const abs = parseSecurity('12 000,00 руб.', 1200000);
check(near(abs.amount, 12000) && near(abs.ratio, 0.01), 'сумма развёрнута в долю от НМЦК');
const none = parseSecurity('не требуется', 1200000);
check(none.amount === 0 && none.required === false, '«не требуется» отличается от «не нашли»');

section('Сборка запроса: данные клиента в промпт не попадают');
// В тендер намеренно подмешаны данные, которые в модель уходить не должны.
const enriched = {
  ...TENDER,
  priceList: [{ article: 'A4-500', price: 320, stock: 400 }],
  costRatio: 0.62,
  margin: 180000,
  clientName: 'ООО Ромашка'
};
const req = buildExtractionRequest(enriched, DOC);
check(req.ok, 'запрос собран');
check(!/A4-500|320|0\.62|180000|Ромашка/.test(req.user + req.system),
  'прайс, себестоимость, маржа и имя клиента в запросе отсутствуют');
check(CARD_FIELDS.every((f) => f !== 'price' || req.user.includes('1200000')),
  'разрешённые поля карточки переданы');
check(req.user.includes(DOC), 'текст документации передан целиком');
check(/quote/.test(req.system) && /null/.test(req.system),
  'модели прямо предписано давать цитату и отвечать null при отсутствии данных');

section('Защёлка: документ с контактами наружу не уходит');
const dirty = DOC + '\nКонтактное лицо: Иванов Иван Иванович, тел. +7 (495) 123-45-67';
const blocked = buildExtractionRequest(TENDER, dirty);
check(!blocked.ok, 'запрос не собран, пока контакты не вырезаны');
check(blocked.blocked.length > 0, `причина названа: ${blocked.blocked[0]}`);
const empty = buildExtractionRequest(TENDER, '   ');
check(!empty.ok, 'пустой документ не отправляется');

section('Разбор ответа модели');
check(parseExtraction(JSON.stringify(goodAnswer)).ok, 'чистый JSON');
check(parseExtraction('```json\n{"a":1}\n```').ok, 'JSON в обёртке из тройных кавычек');
check(parseExtraction('Вот результат: {"a":1} — готово').ok, 'JSON с текстом вокруг');
check(!parseExtraction('').ok, 'пустой ответ отклонён');
check(!parseExtraction('извините, не могу').ok, 'ответ без JSON отклонён');
check(!parseExtraction('[1,2,3]').ok, 'массив вместо объекта отклонён');

section('Нормальный ответ проходит проверку');
const good = verifyExtraction(goodAnswer, TENDER, DOC, NOW);
check(good.confidence === 'высокая', `уверенность высокая (получено «${good.confidence}»)`);
check(good.conflicts.length === 0, 'расхождений с карточкой нет');
check(good.issues.length === 0, `невозможных значений нет${good.issues.length ? ': ' + good.issues.join('; ') : ''}`);
check(Object.values(good.fields).every((f) => f.grounded), 'все девять полей подтверждены цитатами');
check(good.items.length === 2 && good.items.every((i) => i.problems.length === 0),
  'обе позиции лота разобраны без замечаний');
check(near(good.security.bid.amount, 12000) && near(good.security.contract.amount, 60000),
  'обеспечения посчитаны в рублях от НМЦК');

section('ВЫДУМАННАЯ ЦИТАТА — главная проверка');
const fabricated = clone(goodAnswer);
fabricated.bidSecurity = {
  value: '24 000,00',
  quote: 'Размер обеспечения заявки составляет 24 000 рублей 00 копеек.',
  confidence: 'высокая'
};
const fab = verifyExtraction(fabricated, TENDER, DOC, NOW);
check(fab.fields.bidSecurity.grounded === false, 'цитата, которой нет в документе, не подтверждена');
check(fab.confidence === 'требует проверки',
  'уверенная выдумка в критичном поле уводит тендер на проверку человеком');
check(fab.issues.some((i) => /цитата/.test(i)), 'в замечаниях сказано, что именно не подтвердилось');

const noQuote = clone(goodAnswer);
noQuote.deadline = { value: '2026-10-20', quote: '', confidence: 'высокая' };
const nq = verifyExtraction(noQuote, TENDER, DOC, NOW);
check(nq.confidence === 'требует проверки', 'значение без цитаты вообще тоже не принимается');

const bareValue = clone(goodAnswer);
bareValue.nmck = 1200000; // модель ответила числом без обёртки
const bv = verifyExtraction(bareValue, TENDER, DOC, NOW);
check(bv.fields.nmck.grounded === false, 'значение без обёртки не считается подтверждённым');

section('Перекрёстная сверка с карточкой');
const conflictNmck = clone(goodAnswer);
conflictNmck.nmck = { value: '1 250 000,00', quote: 'Начальная (максимальная) цена контракта: 1 200 000,00 руб.', confidence: 'высокая' };
const cn = verifyExtraction(conflictNmck, TENDER, DOC, NOW);
check(cn.conflicts.some((c) => c.field === 'НМЦК'), 'расхождение НМЦК поймано');
check(cn.conflicts[0].fromCard === 1200000 && cn.conflicts[0].fromDocs === 1250000,
  'в расхождении названы оба значения, выбор наугад не сделан');
check(cn.confidence === 'требует проверки', 'расхождение критичного числа уводит на проверку');

const conflictDeadline = clone(goodAnswer);
conflictDeadline.deadline = { value: '2026-10-18', quote: 'Дата и время окончания срока подачи заявок: 20.10.2026 09:00.', confidence: 'высокая' };
const cd = verifyExtraction(conflictDeadline, TENDER, DOC, NOW);
check(cd.conflicts.some((c) => /подач/.test(c.field)), 'расхождение срока подачи поймано');
check(cd.conflicts.some((c) => /наиболее раннему/.test(c.note)),
  'подсказано безопасное поведение: ориентироваться на более ранний срок');

// У 223-ФЗ способом «Иной способ» срока в карточке может не быть вовсе.
const noCardDeadline = verifyExtraction(goodAnswer, { ...TENDER, deadline: null }, DOC, NOW);
check(noCardDeadline.conflicts.length === 0,
  'отсутствие срока в карточке — не расхождение: документация становится единственным источником');
check(/только из документации/.test(noCardDeadline.fields.deadline.note || ''),
  'источник значения помечен явно');

section('ПРЕДЕЛ ОБЕСПЕЧЕНИЯ ЗАЯВКИ ЗАВИСИТ ОТ НМЦК');
// Статья 44 44-ФЗ, сверено с первоисточником 30.09.2026.
// До 20 млн предел 1%, свыше — 5%. Прежняя проверка держала плоские 5%
// при любой цене и пропускала невозможное: обеспечение 3% при НМЦК в миллион
// уходило в расчёт как факт и занижало потребность в оборотных средствах.
check(bidSecurityLimit(1000000) === 0.01, 'для НМЦК 1 млн предел 1%');
check(bidSecurityLimit(20000000) === 0.01, 'ровно на 20 млн ещё 1%, порог не включается');
check(bidSecurityLimit(20000001) === 0.05, 'свыше 20 млн предел 5%');
check(bidSecurityLimit(null) === 0.05, 'без известной НМЦК берётся мягкий предел');

const overBidSmall = clone(goodAnswer);
overBidSmall.bidSecurity = { value: '3%', quote: 'Размер обеспечения заявки на участие: 1% от начальной максимальной цены контракта.', confidence: 'высокая' };
const obs = verifyExtraction(overBidSmall, TENDER, DOC, NOW); // НМЦК 1 200 000
check(obs.issues.some((i) => /обеспечение заявки/.test(i) && /статьёй 44/.test(i)),
  'обеспечение заявки 3% при НМЦК 1,2 млн помечено — по закону предел 1%');

const bigTender = { ...TENDER, price: 50000000 };
const obl = verifyExtraction(overBidSmall, bigTender, DOC, NOW);
check(!obl.issues.some((i) => /обеспечение заявки/.test(i)),
  'то же самое 3% при НМЦК 50 млн законно и не помечается');

section('Нижние границы обеспечений');
const tinyBid = clone(goodAnswer);
tinyBid.bidSecurity = { value: '0,1%', quote: 'Размер обеспечения заявки на участие: 1% от начальной максимальной цены контракта.', confidence: 'высокая' };
const tb = verifyExtraction(tinyBid, TENDER, DOC, NOW);
check(tb.issues.some((i) => /ниже установленного законом минимума/.test(i)),
  'обеспечение заявки 0,1% помечено — минимум по закону 0,5%');

const noBid = clone(goodAnswer);
noBid.bidSecurity = { value: 'не требуется', quote: 'Размер обеспечения заявки на участие: 1% от начальной максимальной цены контракта.', confidence: 'высокая' };
const nb = verifyExtraction(noBid, TENDER, DOC, NOW);
check(!nb.issues.some((i) => /минимума/.test(i)),
  '«не требуется» это законный ноль, а не нарушение нижней границы');

section('Физически невозможные значения');
const hugeBid = clone(goodAnswer);
hugeBid.bidSecurity = { value: '50%', quote: 'Размер обеспечения заявки на участие: 1% от начальной максимальной цены контракта.', confidence: 'высокая' };
const hb = verifyExtraction(hugeBid, TENDER, DOC, NOW);
check(hb.issues.some((i) => /обеспечение заявки/.test(i)), 'обеспечение заявки выше 5% помечено');
check(hb.issues.some((i) => /перепутано/.test(i)), 'названа вероятная причина ошибки');

const overNmck = clone(goodAnswer);
overNmck.contractSecurity = { value: '2 000 000,00 руб.', quote: 'Размер обеспечения исполнения контракта: 5% от начальной максимальной цены контракта.', confidence: 'высокая' };
const on = verifyExtraction(overNmck, TENDER, DOC, NOW);
check(on.issues.some((i) => /больше НМЦК/.test(i)), 'обеспечение больше НМЦК поймано');

const swapped = clone(goodAnswer);
swapped.deliveryDeadline = { value: '2026-10-01', quote: 'Срок поставки товара: до 15.12.2026 включительно.', confidence: 'высокая' };
const sw = verifyExtraction(swapped, TENDER, DOC, NOW);
check(sw.issues.some((i) => /перепутаны/.test(i)), 'срок поставки раньше срока подачи поймано');

const expired = verifyExtraction(goodAnswer, TENDER, DOC, new Date('2026-11-01T00:00:00Z'));
check(expired.issues.some((i) => /уже прошёл/.test(i)), 'просроченный срок подачи помечен');

section('Позиции лота');
const badItems = clone(goodAnswer);
badItems.items = [
  { name: '', quantity: 500, unit: 'упак', quote: 'Позиция 1: Бумага для офисной техники А4, 500 упаковок.' },
  { name: 'Папка', quantity: 0, unit: 'шт', quote: 'Позиция 2: Папка-регистратор 75 мм, 300 штук.' },
  { name: 'Ручка шариковая', quantity: 100, unit: 'шт', quote: 'Позиция 3: Ручка шариковая синяя, 100 штук.' }
];
const bi = verifyExtraction(badItems, TENDER, DOC, NOW);
check(bi.items[0].problems.includes('нет наименования'), 'позиция без названия помечена');
check(bi.items[1].problems.some((p) => /меньше или равно нулю/.test(p)), 'нулевое количество помечено');
check(bi.items[2].problems.some((p) => /цитата/.test(p)),
  'позиция, которой нет в документе, помечена — модель добавила её от себя');

const noItems = clone(goodAnswer);
noItems.items = [];
const ni = verifyExtraction(noItems, TENDER, DOC, NOW);
check(ni.issues.some((i) => /сверка с прайсом невозможна/.test(i)),
  'отсутствие позиций названо прямо: без них не с чем сверять прайс');

section('Факт из документации заменяет допущение в расчёте');
const overrides = factualEconomics(good);
check(near(overrides.bidSecurityRate, 0.01) && near(overrides.contractSecurityRate, 0.05),
  'ставки обеспечения взяты из документации');
const scored = scoreTender(TENDER, { ...overrides, expectedDiscount: 0.10, costRatio: 0.70 }, NOW);
check(near(scored.economics.bidSecurity, 12000) && near(scored.economics.contractSecurity, 60000),
  'расчёт использует фактические обеспечения, а не среднюю ставку');

const shaky = factualEconomics(fab);
check(Object.keys(shaky).length === 0,
  'при неподтверждённом извлечении расчёт остаётся на допущениях, а не подменяется выдумкой');

section('Сводка для человека');
const summary = explainExtraction(cn);
console.log('  ' + summary);
check(/уверенность/.test(summary) && /расхождения/.test(summary), 'сводка называет уверенность и расхождения');
check(!/undefined|NaN|\[object/.test(summary), 'в сводке нет технического мусора');

section('Битый вход не ломает разбор');
const emptyAnswer = verifyExtraction({}, TENDER, DOC, NOW);
check(emptyAnswer.confidence === 'требует проверки', 'пустой ответ модели — это «требует проверки»');
check(Object.values(emptyAnswer.fields).every((f) => f.value === null),
  'из пустого ответа не появилось значений');
const nullDoc = verifyExtraction(goodAnswer, TENDER, '', NOW);
check(nullDoc.confidence === 'требует проверки',
  'без текста документа ни одна цитата не подтверждается');

console.log(`\n${failures === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : 'ПРОВАЛЕНО ПРОВЕРОК: ' + failures}`);
process.exit(failures === 0 ? 0 : 1);
