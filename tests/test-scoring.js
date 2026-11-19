/**
 * Тесты расчёта выгоды.
 * Запуск: node tests/test-scoring.js
 *
 * Арифметика здесь должна быть точной — это требование из AGENTS.md:
 * детерминированные расчёты считаются без ошибок и покрываются тестами.
 */
const {
  scoreTender, explainScore, contractSecurityWithAntidumping,
  DEFAULT_ECONOMICS, ANTIDUMPING
} = require('../src/scoring');

let failures = 0;
const check = (ok, message) => {
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${message}`);
  if (!ok) failures++;
};
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;
const section = (name) => console.log(`\n=== ${name} ===`);

const NOW = new Date('2026-09-26T12:00:00Z');
const tender = (over = {}) => ({
  number: '0318300173926000268',
  price: 1000000,
  deadline: '2026-10-20',
  status: 'Подача заявок',
  ...over
});

section('Арифметика проверяется вручную');
// Проверка на круглых числах, чтобы результат можно было пересчитать в уме.
// НМЦК 1 000 000, падение 10% -> цена победы 900 000
// себестоимость 70% от НМЦК -> 700 000
// налог 6% от 900 000 -> 54 000
// прибыль 900 000 - 700 000 - 54 000 = 146 000
// маржа 146 000 / 900 000 = 16,22%
const manual = scoreTender(tender(), {
  expectedDiscount: 0.10,
  costRatio: 0.70,
  taxRate: 0.06,
  minMarginPct: 10
}, NOW);
const e = manual.economics;
check(near(e.expectedWinPrice, 900000), `цена победы 900 000 (получено ${e.expectedWinPrice})`);
check(near(e.estimatedCost, 700000), `себестоимость 700 000 (получено ${e.estimatedCost})`);
check(near(e.tax, 54000), `налог 54 000 (получено ${e.tax})`);
check(near(e.grossProfit, 146000), `прибыль 146 000 (получено ${e.grossProfit})`);
check(near(e.marginPct, 16.22, 0.02), `маржа 16,22% (получено ${e.marginPct})`);

section('Потребность в оборотных средствах');
// себестоимость 700 000 + обеспечение контракта 5% = 50 000 + обеспечение заявки 1% = 10 000
check(near(e.cashRequired, 760000), `нужно из оборота 760 000 (получено ${e.cashRequired})`);
check(near(e.bidSecurity, 10000) && near(e.contractSecurity, 50000),
  'обеспечения посчитаны по ставкам');

section('Порог маржи');
const thin = scoreTender(tender(), { expectedDiscount: 0.10, costRatio: 0.88, minMarginPct: 10 }, NOW);
check(thin.priority === 'пропустить', 'маржа ниже порога — приоритет «пропустить»');
check(thin.reasons.some(r => /ниже порога/.test(r)), 'причина названа');

const fat = scoreTender(tender(), { expectedDiscount: 0.10, costRatio: 0.50, minMarginPct: 10 }, NOW);
check(fat.priority === 'высокий', `высокая маржа — высокий приоритет (${fat.priority}, score ${fat.score})`);

section('БЕЗ СЕБЕСТОИМОСТИ МАРЖА НЕ ОТСЕИВАЕТ — 70 из 70 «пропустить», 16.10.2026');
// Настройки боевого клиента: снижение 15%, доли себестоимости нет.
const боевые = { expectedDiscount: 0.15, taxRate: 0.06 };
const безСебест = scoreTender(tender(), боевые, NOW);
check(безСебест.priority === 'средний',
  `без доли себестоимости тендер не отсеян (${безСебест.priority})`);
check(безСебест.economics.marginPct === null && безСебест.economics.grossProfit === null,
  'маржа и прибыль — «неизвестно», а не число');
check(безСебест.economics.cashRequired === null,
  'потребность в деньгах не выдаётся одними обеспечениями');
check(безСебест.reasons.some((r) => /себестоимость неизвестна/.test(r)), 'причина названа');
const пояснение = explainScore(безСебест);
check(!/undefined|NaN|null|\b0 ₽/.test(пояснение), `в пояснении нет нуля и мусора: ${пояснение}`);
// Отрицательный контроль: та же закупка с прежней выдуманной долей 75%
// действительно отсеивалась — иначе проверка выше ничего не доказывает.
const сВыдумкой = scoreTender(tender(), { ...боевые, costRatio: 0.75 }, NOW);
check(сВыдумкой.priority === 'пропустить',
  `с долей 75% маржа 5,8% ниже порога — так и было на сервере (${сВыдумкой.economics.marginPct}%)`);
// Маржа по доле одинакова у любой закупки — поэтому она и не может отбирать.
const дорогая = scoreTender(tender({ price: 9000000 }), { ...боевые, costRatio: 0.75 }, NOW);
check(дорогая.economics.marginPct === сВыдумкой.economics.marginPct,
  'при доле себестоимости маржа не зависит от закупки — отбирать ею нельзя');
check(scoreTender(tender({ deadline: '2026-09-01' }), боевые, NOW).priority === 'пропустить',
  'просроченный тендер без себестоимости всё равно отсеян');

section('Оборотные средства как жёсткое ограничение');
const broke = scoreTender(tender(), {
  expectedDiscount: 0.10, costRatio: 0.70, minMarginPct: 10, workingCapital: 500000
}, NOW);
check(broke.priority === 'выгодно, но не по карману',
  `выгодный, но неподъёмный лот выделен отдельно (${broke.priority})`);
check(broke.warnings.some(w => /из оборота/.test(w)), 'в предупреждении названа требуемая сумма');

const affordable = scoreTender(tender(), {
  expectedDiscount: 0.10, costRatio: 0.70, minMarginPct: 10, workingCapital: 2000000
}, NOW);
check(affordable.priority === 'высокий' || affordable.priority === 'средний',
  'при достаточной оборотке ограничение не срабатывает');

section('Сроки');
const urgent = scoreTender(tender({ deadline: '2026-09-27' }), { minDaysToDeadline: 3 }, NOW);
check(urgent.warnings.some(w => /мало времени/.test(w)), 'срочный тендер помечен предупреждением');
check(urgent.economics.daysLeft === 1, `дней до подачи посчитано верно (${urgent.economics.daysLeft})`);

const expired = scoreTender(tender({ deadline: '2026-09-01' }), {}, NOW);
check(expired.priority === 'пропустить', 'просроченный тендер отсеян');

const noDeadline = scoreTender(tender({ deadline: null }), {}, NOW);
check(noDeadline.warnings.some(w => /нет срока подачи/.test(w)),
  'отсутствие срока помечено, но расчёт выполнен');
check(noDeadline.economics !== null, 'расчёт не прерван из-за отсутствия срока');

section('Нераспознанная цена не ломает расчёт молча');
const noPrice = scoreTender(tender({ price: null }), {}, NOW);
check(noPrice.priority === 'требует проверки', 'без цены тендер уходит человеку, а не отбрасывается');
check(noPrice.score === null && noPrice.economics === null, 'выдуманных чисел нет');
check(noPrice.warnings.length > 0, 'сказано, что именно проверить');

section('Честность формулировок');
check(/оценка/.test(manual.basis), 'результат помечен как оценка, а не факт');
check(Object.keys(manual.assumptions).length >= 4, 'допущения перечислены явно');
check(manual.reasons.length > 0, 'причина оценки указана всегда');

section('Пояснение для клиента');
const text = explainScore(manual);
console.log('  ' + text);
check(/НМЦК/.test(text) && /маржа|прибыль/.test(text) && /оборот/.test(text),
  'пояснение содержит цену, прибыль и потребность в деньгах');
check(!/undefined|NaN|null/.test(text), 'в пояснении нет технического мусора');

section('АНТИДЕМПИНГ: обеспечение растёт там, где сделка выглядит выгоднее всего');
// Статья 37 44-ФЗ, сверено с первоисточником 30.09.2026.
// Смысл проверки: система советует торговаться вниз, и ровно на снижении 25%
// требование к деньгам подскакивает в полтора раза. Считать обеспечение
// по начальной цене — значит занизить потребность в оборотных средствах
// именно в тех закупках, которые выглядят самыми привлекательными.

// НМЦК 1 000 000, снижение 20% — порог не достигнут.
const noDump = contractSecurityWithAntidumping(1000000, 800000, 0.05);
check(noDump.applied === false, 'при снижении 20% меры не применяются');
check(near(noDump.amount, 50000), `обеспечение обычное, 50 000 (получено ${noDump.amount})`);

// НМЦК 1 000 000, снижение ровно 25% — порог достигнут.
const atTrigger = contractSecurityWithAntidumping(1000000, 750000, 0.05);
check(atTrigger.applied === true, 'ровно на 25% меры уже применяются, а не «после»');
check(near(atTrigger.amount, 75000), `обеспечение 50 000 × 1,5 = 75 000 (получено ${atTrigger.amount})`);

// НМЦК 20 000 000 — выше порога 15 млн, работает правило «не менее 10% НМЦК».
// База 20 000 000 × 5% = 1 000 000; в полтора раза = 1 500 000;
// но 10% от НМЦК = 2 000 000, и закон требует большее из двух.
const bigDump = contractSecurityWithAntidumping(20000000, 14000000, 0.05);
check(bigDump.applied === true, 'при НМЦК свыше 15 млн меры применяются');
check(near(bigDump.amount, 2000000),
  `взят минимум 10% НМЦК = 2 000 000, а не 1 500 000 (получено ${bigDump.amount})`);
check(/не менее 10%/.test(bigDump.note), 'в пояснении назван именно этот порог');

// Ниже порога 15 млн закон разрешает вместо денег подтвердить добросовестность.
// В расчёте держим денежный вариант: занизить потребность опаснее, чем завысить.
check(/добросовестность/.test(atTrigger.note),
  'для НМЦК до 15 млн сказано про альтернативу с добросовестностью');

section('Антидемпинг внутри расчёта тендера');
const deepCut = scoreTender(tender(), {
  expectedDiscount: 0.30, costRatio: 0.55, contractSecurityRate: 0.05, bidSecurityRate: 0.01
}, NOW);
check(deepCut.economics.antidumping.applied === true, 'снижение 30% включает меры');
check(near(deepCut.economics.contractSecurity, 75000),
  `обеспечение выросло до 75 000 (получено ${deepCut.economics.contractSecurity})`);
// Потребность в деньгах: себестоимость 550 000 + обеспечение 75 000 + заявка 10 000
check(near(deepCut.economics.cashRequired, 635000),
  `в потребность вошло увеличенное обеспечение, 635 000 (получено ${deepCut.economics.cashRequired})`);
check(deepCut.warnings.some((w) => /антидемпинг/.test(w)), 'клиент предупреждён о мерах');
check(deepCut.warnings.some((w) => /аванс запрещён/.test(w)),
  'и отдельно о запрете аванса — для посредника это тяжелее самого обеспечения');
check(deepCut.economics.antidumping.advanceForbidden === true, 'запрет аванса отмечен в расчёте');

const shallowCut = scoreTender(tender(), { expectedDiscount: 0.10, costRatio: 0.70 }, NOW);
check(shallowCut.economics.antidumping.applied === false, 'при снижении 10% мер нет');
check(near(shallowCut.economics.contractSecurity, 50000),
  `обеспечение осталось обычным (получено ${shallowCut.economics.contractSecurity})`);
check(!shallowCut.warnings.some((w) => /аванс запрещён/.test(w)),
  'и ложного предупреждения про аванс нет');

section('Пороги антидемпинга взяты из закона, а не придуманы');
check(ANTIDUMPING.priceDropTrigger === 0.25, 'порог снижения — 25%');
check(ANTIDUMPING.nmckThreshold === 15000000, 'порог НМЦК — 15 млн ₽');
check(ANTIDUMPING.multiplier === 1.5, 'множитель обеспечения — 1,5');
check(ANTIDUMPING.minRatioAboveThreshold === 0.10, 'нижняя граница свыше порога — 10% НМЦК');

section('Значения по умолчанию заданы');
check(typeof DEFAULT_ECONOMICS.expectedDiscount === 'number' &&
      typeof DEFAULT_ECONOMICS.costRatio === 'number',
  'среднеотраслевые ориентиры на месте и перекрываются настройками клиента');

console.log(`\n${failures === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : 'ПРОВАЛЕНО ПРОВЕРОК: ' + failures}`);
process.exit(failures === 0 ? 0 : 1);
