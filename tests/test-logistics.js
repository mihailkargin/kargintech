/**
 * Тесты расчёта логистики.
 * Запуск: node tests/test-logistics.js
 *
 * Проверяется не точность оценки — она заведомо груба, — а то, что система
 * никогда не выдаёт прикидку за цену перевозчика и замечает, когда ответ
 * перевозчика выглядит странно.
 *
 * Опорная точка взята из настоящего ответа ПЭК от 30.09.2026: паллета 300 кг,
 * Москва → Екатеринбург, 12 260 ₽ автотранспортом, срок 4–7 суток.
 */
const {
  estimate, resolveLogistics, totalLogistics,
  distanceBetween, chargeableWeight, findCity, RATES
} = require('../src/logistics');

let failures = 0;
const check = (ok, message) => {
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${message}`);
  if (!ok) failures++;
};
const section = (name) => console.log(`\n=== ${name} ===`);

const shipment = (over = {}) => ({
  from: 'г. Москва, ул. Тверская, 1',
  to: 'г. Екатеринбург, ул. Ленина, 5',
  weightKg: 300,
  volumeM3: 0.96,
  ...over
});

section('Город достаётся из адреса, как его пишут в документации');
check(findCity('г. Москва, ул. Тверская, 1') === 'москва', 'адрес с улицей');
check(findCity('Российская Федерация, Московская обл., г. Москва') === 'москва', 'адрес с областью');
check(findCity('МОСКВА') === 'москва', 'заглавными буквами');
check(findCity('г. Нижний Новгород, пр. Гагарина') === 'нижний новгород',
  'составное название не путается с коротким');
check(findCity('село Кукуево, Тмутараканская обл.') === null,
  'незнакомый город — null, а не ближайшее похожее');
check(findCity('') === null && findCity(null) === null, 'пустой адрес не роняет разбор');

section('Расстояние');
const moscowEkb = distanceBetween('г. Москва', 'г. Екатеринбург');
// По дорогам между Москвой и Екатеринбургом около 1700–1800 км.
check(moscowEkb.km > 1400 && moscowEkb.km < 2100,
  `Москва — Екатеринбург: ${moscowEkb.km} км, правдоподобно`);
check(distanceBetween('Москва', 'Москва').km === 0, 'внутри одного города — ноль');

const unknownRoute = distanceBetween('село Кукуево', 'г. Москва');
check(unknownRoute.km === null, 'неизвестный город — расстояние не выдумывается');
check(unknownRoute.unknown.includes('откуда'), 'сказано, какой конец маршрута не опознан');

section('Расчётный вес: больший из фактического и объёмного');
check(chargeableWeight(300, 0.96).kg === 300,
  'тяжёлый компактный груз считается по фактическому весу');
const light = chargeableWeight(50, 3);
check(light.kg === 750, `лёгкий габаритный — по объёмному: 3 м³ × 250 = 750 кг (получено ${light.kg})`);
check(/объёмный/.test(light.basis), 'основание названо');
check(chargeableWeight(null, null).kg === null, 'без веса и объёма — null, а не ноль');
check(chargeableWeight(100, null).kg === 100, 'только вес — считаем по нему');

section('Собственная оценка накрывает реальный ответ перевозчика');
// Настоящий ответ ПЭК по этому грузу — 12 260 ₽. Оценка не обязана совпадать,
// но обязана быть того же порядка: иначе она бесполезна как проверка.
const own = estimate(shipment());
check(own.amount !== null, 'оценка посчитана');
console.log(`  оценка: ${own.amount} ₽ на ${own.distanceKm} км, реальный ответ ПЭК: 12 260 ₽`);
check(own.amount > 5000 && own.amount < 30000,
  `оценка того же порядка, что ответ ПЭК (получено ${own.amount})`);
check(/не заменяет ответ перевозчика/.test(own.note), 'помечена как прикидка');
check(own.parts.забор > 0 && own.parts.доставка > 0,
  'забор и доставка учтены отдельно — это две трети цены на коротком плече');

section('Оценка не выдумывается при нехватке данных');
const noCity = estimate(shipment({ to: 'село Кукуево' }));
check(noCity.amount === null, 'неизвестный город — оценки нет');
check(noCity.issues.some((i) => /расстояние неизвестно/.test(i)), 'причина названа');

const noWeight = estimate(shipment({ weightKg: null, volumeM3: null }));
check(noWeight.amount === null, 'без веса и объёма — оценки нет');
check(noWeight.issues.some((i) => /не известны ни вес, ни объём/.test(i)), 'причина названа');

section('ОТВЕТЫ ПЕРЕВОЗЧИКОВ: в расчёт идёт худший');
const two = resolveLogistics(shipment(), [
  { carrier: 'ПЭК', amount: 12260, days: 5 },
  { carrier: 'Байкал Сервис', amount: 13500, days: 6 }
]);
check(two.amount === 13500, `взят дороже: 13 500 (получено ${two.amount})`);
check(two.min === 12260 && two.max === 13500, 'диапазон сохранён');
check(two.confidence === 'высокая', 'два согласных источника — высокая уверенность');
check(two.basis === 'ответы перевозчиков', 'основание названо');

section('ЕДИНСТВЕННЫЙ ПЕРЕВОЗЧИК — сверить не с чем');
const one = resolveLogistics(shipment(), [{ carrier: 'ПЭК', amount: 12260, days: 5 }]);
check(one.confidence === 'средняя', 'уверенность не высокая');
check(one.warnings.some((w) => /единственного перевозчика/.test(w)),
  'сказано прямо, что источник один');

section('БАЛАНС: оценка страхует снизу, когда перевозчик один');
// Самый опасный случай: перевозчик посчитал только перевоз между терминалами,
// без забора у поставщика и доставки до двери. Это две трети стоимости.
// Взять такую цифру значит завысить прибыль и привести клиента в убыток.
const tooCheap = resolveLogistics(shipment(), [{ carrier: 'ПЭК', amount: 4000 }]);
check(tooCheap.amount > 4000,
  `в расчёт взята не заниженная цифра перевозчика (получено ${tooCheap.amount})`);
check(tooCheap.amount === tooCheap.own.amount,
  'взята собственная оценка как более осторожная');
check(/собственная оценка выше/.test(tooCheap.basis), `основание названо: «${tooCheap.basis}»`);
check(tooCheap.warnings.some((w) => /без забора и доставки до двери/.test(w)),
  'названа вероятная причина занижения, а не просто «странно»');

// Два перевозчика проверяют друг друга — формуле вмешиваться незачем,
// даже если оба дали мало. Они знают свои тарифы лучше нашей прикидки.
const twoCheap = resolveLogistics(shipment(), [
  { carrier: 'ПЭК', amount: 4000 },
  { carrier: 'Байкал Сервис', amount: 4200 }
]);
check(twoCheap.amount === 4200,
  `при двух согласных источниках взят их ответ, а не оценка (получено ${twoCheap.amount})`);
check(!/собственная оценка выше/.test(twoCheap.basis), 'оценка не подменяет согласованный ответ');

// Перевозчик дороже оценки — доверяем ему, он считает по конкретному грузу.
const dearer = resolveLogistics(shipment(), [{ carrier: 'ПЭК', amount: 20000 }]);
check(dearer.amount === 20000, 'ответ дороже оценки принимается как есть');

section('СВЕРКА С СОБСТВЕННОЙ ОЦЕНКОЙ ловит странный ответ');
// Перевозчик посчитал отдельную машину вместо сборного груза — цена в разы выше.
const weird = resolveLogistics(shipment(), [{ carrier: 'ПЭК', amount: 90000 }]);
check(weird.warnings.some((w) => /расходится с собственной оценкой/.test(w)),
  'расхождение вдвое замечено');
check(weird.warnings.some((w) => /тип отправки/.test(w)),
  'подсказана вероятная причина, а не просто «странно»');

const sane = resolveLogistics(shipment(), [{ carrier: 'ПЭК', amount: 12260 }]);
check(!sane.warnings.some((w) => /расходится с собственной/.test(w)),
  'на правдоподобном ответе ложной тревоги нет');

section('НИ ОДИН ПЕРЕВОЗЧИК НЕ ОТВЕТИЛ');
const none = resolveLogistics(shipment(), []);
check(none.amount !== null, 'расчёт не обнуляется — работаем на своей оценке');
check(none.basis === 'только собственная оценка', 'основание названо честно');
check(none.confidence === 'требует проверки', 'уверенность понижена');
check(none.warnings.some((w) => /может отличаться от реальной в разы/.test(w)),
  'клиент предупреждён, насколько это грубо');

const hopeless = resolveLogistics(shipment({ to: 'село Кукуево', weightKg: null, volumeM3: null }), []);
check(hopeless.amount === null, 'ни перевозчиков, ни данных — цифры нет');
check(hopeless.basis === 'логистика не рассчитана', 'так и сказано');
check(hopeless.warnings.some((w) => /прибыль без неё неполна/.test(w)),
  'сказано, что прибыль без логистики считать нельзя');

section('Разброс между перевозчиками');
const spread = resolveLogistics(shipment(), [
  { carrier: 'ПЭК', amount: 12000 },
  { carrier: 'Энергия', amount: 25000 }
]);
check(spread.spreadPct > 100, `разброс ${spread.spreadPct}% посчитан`);
check(spread.confidence === 'требует проверки', 'при большом разбросе уверенность понижена');
check(spread.amount === 25000, 'в расчёт всё равно взят дорогой');

section('ЛОГИСТИКА ДВУНОГАЯ: от поставщика и до заказчика');
const legA = resolveLogistics(shipment(), [{ carrier: 'ПЭК', amount: 12260 }]);
const legB = resolveLogistics(
  shipment({ from: 'г. Екатеринбург', to: 'г. Челябинск' }),
  [{ carrier: 'ПЭК', amount: 4000 }]
);
const both = totalLogistics([legA, legB]);
check(both.amount === 16260, `оба плеча сложены: 12 260 + 4 000 (получено ${both.amount})`);
check(both.complete === true, 'обе части посчитаны');

const onlyOne = totalLogistics([legA]);
check(onlyOne.amount === 12260, 'прямая поставка от поставщика заказчику — одно плечо, это законно');
check(onlyOne.complete === true, 'и это не считается неполным расчётом');

const broken = totalLogistics([legA, resolveLogistics(shipment({ to: 'село Кукуево' }), [])]);
check(broken.complete === false, 'нерассчитанное плечо делает итог неполным');
check(broken.warnings.some((w) => /итог по логистике неполный/.test(w)), 'сказано прямо');

section('Битый вход');
check(totalLogistics([]).amount === 0, 'пустой список плеч не роняет расчёт');
check(totalLogistics(null).complete === false, 'null не роняет расчёт');
check(!/undefined|NaN/.test(JSON.stringify(resolveLogistics(shipment(), []))),
  'в результате нет технического мусора');

section('Ставки вынесены в настройки');
check(typeof RATES.perKgPerKm === 'number' && typeof RATES.volumetricRatio === 'number',
  'тарифы задаются числами и калибруются по фактическим расчётам');

console.log(`\n${failures === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : 'ПРОВАЛЕНО ПРОВЕРОК: ' + failures}`);
process.exit(failures === 0 ? 0 : 1);
