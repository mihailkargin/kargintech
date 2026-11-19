/**
 * Тесты определения закупочной цены.
 * Запуск: node tests/test-pricing.js
 *
 * Здесь проверяется главное свойство ядра продукта: система НЕ придумывает
 * цену там, где её не нашла, и НЕ выдаёт неполную смету за полную. Ошибка
 * в эту сторону приводит клиента в убыточный контракт — а это хуже, чем
 * пропущенный тендер.
 */
const {
  makePrice, resolvePosition, buildEstimate, sourceRows, SOURCES
} = require('../src/pricing');

let failures = 0;
const check = (ok, message) => {
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${message}`);
  if (!ok) failures++;
};
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;
const section = (name) => console.log(`\n=== ${name} ===`);

const pos = (over = {}) => ({ name: 'Бумага А4 80 г/м2', quantity: 500, unit: 'упак', ...over });

const price = (over = {}) => makePrice({
  price: 300,
  source: SOURCES.NMCK,
  url: 'https://zakupki.gov.ru/doc/1',
  date: '2026-09-20',
  evidence: 'обоснование НМЦК, строка 3',
  ...over
});

section('Цена без источника в расчёт не идёт');
const noSource = makePrice({ price: 300 });
check(!noSource.usable, 'цена без источника непригодна');
check(noSource.problems.some((p) => /источник/.test(p)), 'причина названа');

const noProof = makePrice({ price: 300, source: SOURCES.NMCK });
check(!noProof.usable, 'цена без ссылки и без документа непригодна');
check(noProof.problems.some((p) => /подтвержд/.test(p)),
  'сказано, что нечем подтвердить — иначе не ответить на вопрос «откуда цифра»');

const zero = makePrice({ price: 0, source: SOURCES.NMCK, url: 'https://x' });
check(!zero.usable, 'нулевая цена непригодна');
const negative = makePrice({ price: -5, source: SOURCES.NMCK, url: 'https://x' });
check(!negative.usable, 'отрицательная цена непригодна');

section('Источник определяет, ЧТО означает цена');
check(price({ source: SOURCES.CONTRACT_REGISTRY }).kind === 'верхняя граница',
  'цена из реестра контрактов — верхняя граница, а не себестоимость');
check(/маржу победителя/.test(price({ source: SOURCES.CONTRACT_REGISTRY }).note),
  'прямо сказано, что в ней чужая маржа');
check(price({ source: SOURCES.NMCK }).kind === 'верхняя граница',
  'цена из обоснования НМЦК — тоже верхняя граница');
check(/завышена/.test(price({ source: SOURCES.NMCK }).note),
  'сказано, что заказчику выгодно обосновать цену повыше');
check(price({ source: SOURCES.SUPPLIER }).kind === 'закупочная',
  'цена от поставщика клиента — настоящая закупочная');
check(price({ source: SOURCES.MARKETPLACE }).trust === 'низкая',
  'маркетплейс — источник наименьшего доверия');

section('ПОЗИЦИЯ БЕЗ ЦЕНЫ НЕ ЗАПОЛНЯЕТСЯ ДОГАДКОЙ');
const nothing = resolvePosition(pos(), []);
check(nothing.priceForCalc === null, 'цены нет — и ничего не подставлено');
check(nothing.total === undefined || nothing.total === null, 'суммы тоже нет');
check(nothing.basis === 'цена не определена', `основание названо прямо: «${nothing.basis}»`);
check(nothing.confidence === 'нет данных', 'уверенность — «нет данных»');
check(nothing.warnings.length > 0, 'предупреждение выдано');

const allBad = resolvePosition(pos(), [makePrice({ price: 300 }), makePrice({ price: 0, source: SOURCES.NMCK })]);
check(allBad.priceForCalc === null, 'непригодные цены не спасают положение');
check(/ни одна не пригодна/.test(allBad.warnings[0]), 'сказано, сколько нашли и почему не подошло');
check(allBad.rejected.length === 2, 'отброшенные цены сохранены для разбора');

section('ВЕРХНИЕ ГРАНИЦЫ: берётся САМЫЙ НИЗКИЙ ПОТОЛОК');
// ПРАВИЛО ИЗМЕНЕНО 03.10.2026 после первого настоящего прогона.
//
// Раньше здесь бралась максимальная цена — «ошибиться в сторону дороже
// безопаснее». Для РАЗНЫХ ОЦЕНОК ОДНОЙ величины это верно. Но коммерческие
// предложения в обосновании НМЦК — не оценки, а предложения разных
// поставщиков, из которых можно выбрать.
//
// Если один готов продать заказчику за 200, купить этот товар дороже 200
// невозможно: он сам покупает дешевле и живёт с разницы. Значит минимальное
// предложение и есть верхняя граница себестоимости, а максимальное
// не ограничивает ничего.
//
// Последствие старого правила было системным. Заказчик считает НМЦК
// по СРЕДНЕЙ цене предложений, мы брали МАКСИМУМ — и по любой позиции
// без цен поставщиков сумма выходила выше НМЦК. Система отвечала
// «убыточно» на всё подряд, то есть была бесполезна.
const spread = resolvePosition(pos(), [
  price({ price: 200 }), price({ price: 300 }), price({ price: 260 })
]);
check(spread.priceForCalc === 200,
  `взят самый низкий потолок 200, а не максимум 300 (получено ${spread.priceForCalc})`);
check(spread.min === 200 && spread.max === 300, 'диапазон сохранён целиком');
check(near(spread.spreadPct, 50), `разброс посчитан: 50% (получено ${spread.spreadPct})`);
check(spread.total === 100000, `сумма: 200 × 500 = 100 000 (получено ${spread.total})`);
check(spread.sources.length === 3, 'все источники перечислены, а не только победивший');

section('ЗАКУПОЧНЫЕ ЦЕНЫ: в расчёт - лучшая, худшая - край вилки (владелец 28.10.2026)');
const закупки = resolvePosition(pos(), [
  price({ price: 200, source: SOURCES.WEB_SUPPLIER, supplier: 'А' }),
  price({ price: 260, source: SOURCES.WEB_SUPPLIER, supplier: 'Б' })
]);
check(закупки.priceForCalc === 200,
  `среди закупочных в расчёт взята ЛУЧШАЯ 200 (получено ${закупки.priceForCalc})`);
check(закупки.worstPurchase === 260, `худшая 260 сохранена для вилки (получено ${закупки.worstPurchase})`);

section('Большой разброс — повод усомниться, а не усреднить');
const wild = resolvePosition(pos(), [price({ price: 100 }), price({ price: 400 })]);
check(wild.spreadPct === 300, `разброс 300% (получено ${wild.spreadPct})`);
check(wild.confidence === 'требует проверки', 'уверенность понижена');
check(wild.warnings.some((w) => /об одном ли товаре/.test(w)),
  'подсказано, что дело может быть не в цене, а в разных товарах');

section('Только верхние границы — прибыль занижена, и это сказано');
const ceilings = resolvePosition(pos(), [
  price({ source: SOURCES.NMCK, price: 300 }),
  price({ source: SOURCES.CONTRACT_REGISTRY, price: 320 })
]);
check(ceilings.basis === 'верхняя граница цены', 'основание помечено как верхняя граница');
check(ceilings.warnings.some((w) => /прибыль в расчёте занижена/.test(w)),
  'клиент предупреждён, что смотрит на пессимистичную оценку');

const real = resolvePosition(pos(), [
  price({ source: SOURCES.SUPPLIER, price: 250 }),
  price({ source: SOURCES.NMCK, price: 300 })
]);
check(real.basis === 'закупочная цена',
  'если есть цена от поставщика клиента, основание — настоящая закупка');
check(!real.warnings.some((w) => /занижена/.test(w)), 'ложного предупреждения нет');

section('Единственный источник');
const alone = resolvePosition(pos(), [price({ price: 300 })]);
check(alone.confidence === 'средняя', 'уверенность не высокая — сверить не с чем');
check(alone.warnings.some((w) => /единственн/.test(w)), 'сказано прямо');

section('НЕПОЛНАЯ СМЕТА НЕ ВЫДАЁТСЯ ЗА ПОЛНУЮ');
const positions = [
  pos({ name: 'Бумага А4', quantity: 500 }),
  pos({ name: 'Папка-регистратор', quantity: 300 }),
  pos({ name: 'Редкий артикул без цены', quantity: 10 })
];
const estimate = buildEstimate(positions, (p) =>
  p.name.includes('Редкий') ? [] : [price({ price: 100 })]
);
check(estimate.pricedCount === 2 && estimate.unpricedCount === 1,
  `посчитано 2, не найдено 1 (получено ${estimate.pricedCount}/${estimate.unpricedCount})`);
check(estimate.complete === false, 'смета помечена как неполная');
check(estimate.issues.some((i) => /сравнивать его с НМЦК нельзя/.test(i)),
  'сказано прямо: неполный итог нельзя сравнивать с начальной ценой');
check(estimate.total === 80000, `итог только по найденным: 100×500 + 100×300 = 80 000 (получено ${estimate.total})`);

const full = buildEstimate([pos()], () => [price({ price: 100 })]);
check(full.complete === true, 'смета со всеми ценами помечена как полная');

section('Диапазон итога, а не одна цифра');
const ranged = buildEstimate([pos({ quantity: 10 })], () => [
  price({ price: 100, source: SOURCES.WEB_SUPPLIER, supplier: 'А' }), price({ price: 150, source: SOURCES.WEB_SUPPLIER, supplier: 'Б' })
]);
check(ranged.total === 1000 && ranged.totalMin === 1000 && ranged.totalMax === 1500 && ranged.totalWorst === 1500,
  `закупочные 100 и 150: итог 1 000 по лучшей, вилка до 1 500 (получено ${ranged.total}; ${ranged.totalMin}–${ranged.totalMax}; худшая ${ranged.totalWorst})`);
const потолки = buildEstimate([pos({ quantity: 10 })], () => [price({ price: 100 }), price({ price: 150 })]);
check(потолки.totalMax === 1500 && потолки.totalWorst === 1000,
  `только потолки: диапазон источников 1 000-1 500 показан, но худший край прибыли не потолок (получено ${потолки.totalMax}, ${потолки.totalWorst})`);

section('Позиция с ценой, но без количества');
const noQty = buildEstimate([pos({ quantity: null })], () => [price({ price: 100 })]);
check(noQty.issues.some((i) => /без количества/.test(i)), 'помечено отдельно');
check(noQty.total === 0, 'в итог такая позиция не попала, а не посчиталась как ноль штук');

section('Лист «Источники» для таблицы клиента');
const rows = sourceRows(estimate);
check(rows.length >= 3, `строк источников: ${rows.length}`);
check(rows.some((r) => r.источник === 'не найден'),
  'позиция без цены тоже попала в лист — клиент видит, что именно не нашлось');
check(rows.every((r) => r.позиция && r.источник), 'у каждой строки есть позиция и источник');
console.log('  пример строки:', JSON.stringify(rows[0]));

section('Битый вход');
check(buildEstimate([], () => []).issues.some((i) => /пуста/.test(i)), 'пустая спецификация помечена');
check(buildEstimate(null, () => []).rows.length === 0, 'null не роняет разбор');
check(resolvePosition(null, []).priceForCalc === null, 'позиция null не роняет разбор');
check(!/undefined|NaN/.test(JSON.stringify(resolvePosition(pos(), []))),
  'в результате нет технического мусора');

console.log(`\n${failures === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : 'ПРОВАЛЕНО ПРОВЕРОК: ' + failures}`);
process.exit(failures === 0 ? 0 : 1);
