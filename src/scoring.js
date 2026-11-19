/**
 * Оценка выгоды участия в тендере.
 *
 * ВАЖНО ПРО ПРИРОДУ ЧИСЕЛ.
 * Здесь два разных типа величин, и путать их нельзя:
 *
 *   1. Арифметика — считается точно. Если входные данные верны, результат верен.
 *   2. Допущения — ожидаемое падение цены на торгах, доля себестоимости,
 *      размер обеспечения. Это оценки, а не факты.
 *
 * Значения по умолчанию — усреднённые ориентиры для первого запуска, а не
 * измеренные показатели. Каждое настраивается под клиента.
 *
 * На третьей фазе (разбор протоколов и реестра контрактов) допущение об
 * ожидаемом падении цены заменяется реальной статистикой по категории и
 * заказчику. До этого момента результат — ориентир, и так он и помечается.
 *
 * Точный размер обеспечения указан в документации каждой закупки. Здесь он
 * оценивается по ставке; на этапе разбора документации значение заменяется
 * фактическим.
 */

/** Ориентиры для первого запуска. Калибруются под клиента и по накопленным данным. */
const DEFAULT_ECONOMICS = {
  costRatio: 0.75,            // себестоимость как доля от НМЦК
  expectedDiscount: 0.12,     // ожидаемое падение цены на торгах
  bidSecurityRate: 0.01,      // обеспечение заявки, доля НМЦК
  contractSecurityRate: 0.05, // обеспечение контракта, доля НМЦК
  taxRate: 0.06,              // налог с дохода
  minMarginPct: 10,           // ниже этой маржи участие не интересно
  minDaysToDeadline: 3,       // меньше — риск не успеть собрать заявку
  workingCapital: null        // потолок собственных средств; null — не ограничен
};

const round2 = (n) => Math.round(n * 100) / 100;
const daysBetween = (fromIso, toIso) =>
  Math.round((new Date(toIso) - new Date(fromIso)) / (24 * 60 * 60 * 1000));

/**
 * Антидемпинговые меры, статья 37 44-ФЗ.
 * Сверено с действующей редакцией по первоисточнику 30.09.2026.
 *
 * ЗАЧЕМ ЭТО В РАСЧЁТЕ. Система советует торговаться вниз. Как только снижение
 * достигает 25% от начальной цены, обеспечение контракта увеличивается
 * в полтора раза — то есть ровно в тот момент, когда сделка выглядит самой
 * выгодной, требование к деньгам подскакивает. Клиент может выиграть торг
 * и не суметь подписать контракт.
 *
 * ВТОРОЕ, ЧТО ВАЖНЕЕ ДЕНЕГ НА ОБЕСПЕЧЕНИЕ. Часть 13 той же статьи запрещает
 * аванс при антидемпинге. Значит всю поставку клиент финансирует сам,
 * и замороженная сумма растёт ещё и на это.
 */
const ANTIDUMPING = {
  priceDropTrigger: 0.25,   // снижение, с которого меры включаются
  nmckThreshold: 15000000,  // порог НМЦК: выше — увеличенное обеспечение обязательно
  multiplier: 1.5,          // во сколько раз растёт обеспечение контракта
  minRatioAboveThreshold: 0.10, // но не менее 10% НМЦК, когда НМЦК выше порога
  advanceForbidden: true    // часть 13: аванс не допускается
};

/**
 * Считает обеспечение контракта с учётом антидемпинга.
 *
 * @param {number} nmck начальная цена
 * @param {number} offerPrice цена, с которой заходим на торги
 * @param {number} baseRate обычная ставка обеспечения, доля НМЦК
 * @returns {{amount: number, applied: boolean, dropPct: number, note: string}}
 */
function contractSecurityWithAntidumping(nmck, offerPrice, baseRate) {
  const base = nmck * baseRate;
  const drop = nmck > 0 ? (nmck - offerPrice) / nmck : 0;

  if (drop < ANTIDUMPING.priceDropTrigger) {
    return { amount: base, applied: false, dropPct: round2(drop * 100), note: '' };
  }

  const increased = base * ANTIDUMPING.multiplier;

  // При НМЦК свыше порога закон требует ещё и «не менее 10% начальной цены».
  // Ниже порога участник вправе вместо денег подтвердить добросовестность —
  // но это его выбор и его документы, поэтому в расчёте держим денежный
  // вариант как худший. Занизить здесь опаснее, чем завысить.
  const amount = nmck > ANTIDUMPING.nmckThreshold
    ? Math.max(increased, nmck * ANTIDUMPING.minRatioAboveThreshold)
    : increased;

  const note = nmck > ANTIDUMPING.nmckThreshold
    ? `снижение ${round2(drop * 100)}% включает антидемпинг: обеспечение в 1,5 раза, но не менее 10% НМЦК (ст. 37)`
    : `снижение ${round2(drop * 100)}% включает антидемпинг: обеспечение в 1,5 раза (ст. 37). ` +
      'При НМЦК до 15 млн вместо денег закон разрешает подтвердить добросовестность — ' +
      'в расчёте держим денежный вариант как худший';

  return { amount, applied: true, dropPct: round2(drop * 100), note };
}

/**
 * @param {object} tender карточка из parseSearchPage
 * @param {object} economics настройки клиента, перекрывают значения по умолчанию
 * @param {Date} now точка отсчёта
 */
function scoreTender(tender, economics = {}, now = new Date()) {
  const cfg = { ...DEFAULT_ECONOMICS, ...economics };
  const reasons = [];
  const warnings = [];

  // Без цены считать нечего. Тендер не выбрасываем: отправляем человеку.
  if (tender.price === null || tender.price === undefined) {
    return {
      priority: 'требует проверки',
      score: null,
      basis: 'расчёт невозможен',
      reasons: ['НМЦК не распознана, расчёт выгоды невозможен'],
      warnings: ['проверить начальную цену вручную по ссылке на закупку'],
      economics: null
    };
  }

  // СЕБЕСТОИМОСТЬ ДО РАЗБОРА ДОКУМЕНТАЦИИ НЕИЗВЕСТНА — найдено 16.10.2026.
  //
  // Здесь стояла доля себестоимости 75% от НМЦК по умолчанию. Это выдуманное
  // число, и вместе с ним маржа выходит ОДИНАКОВОЙ у всех тендеров: она
  // зависит только от настроек, а не от закупки. При снижении 15% из настроек
  // клиента — 5,8% у каждого, ниже порога 10%. Первый живой прогон через n8n
  // пометил «пропустить» все 70 новых тендеров, и клиент не получил ничего.
  //
  // Теперь маржа считается и отсеивает, только если клиент сам задал долю
  // себестоимости (`economics.costRatio`). Без неё отбор идёт по фактам
  // карточки: цена, срок. Выгоду показывает расчёт по кнопке.
  const себестоимостьИзвестна = typeof economics.costRatio === 'number';

  const nmck = tender.price;
  const expectedWinPrice = nmck * (1 - cfg.expectedDiscount);
  const estimatedCost = себестоимостьИзвестна ? nmck * cfg.costRatio : null;
  const tax = expectedWinPrice * cfg.taxRate;
  const grossProfit = себестоимостьИзвестна ? expectedWinPrice - estimatedCost - tax : null;
  const marginPct = !себестоимостьИзвестна ? null
    : expectedWinPrice > 0 ? (grossProfit / expectedWinPrice) * 100 : 0;

  // Сколько денег нужно вынуть из оборота. Обеспечение заявки возвращается
  // после торгов, обеспечение контракта удерживается на время исполнения,
  // товар оплачивается до получения денег от заказчика.
  //
  // Обеспечение контракта считается от ОЖИДАЕМОЙ ЦЕНЫ ПОБЕДЫ, а не от НМЦК:
  // если снижение достигает 25%, включается статья 37 и обеспечение растёт
  // в полтора раза. Считать его по начальной цене значит занизить потребность
  // в деньгах ровно в тех закупках, которые выглядят самыми выгодными.
  const bidSecurity = nmck * cfg.bidSecurityRate;
  const security = contractSecurityWithAntidumping(nmck, expectedWinPrice, cfg.contractSecurityRate);
  const contractSecurity = security.amount;
  // Без себестоимости потребность в деньгах не считается: одни обеспечения
  // выглядели бы полной суммой. Тот же класс, что «Требуемый объём средств:
  // 4 575 ₽» 07.10.2026.
  const cashRequired = себестоимостьИзвестна ? estimatedCost + contractSecurity + bidSecurity : null;
  // round2(null) даёт 0 — «ноль» вместо «неизвестно». Поэтому отдельно.
  const r2 = (n) => (n === null ? null : round2(n));

  const result = {
    nmck,
    expectedWinPrice: round2(expectedWinPrice),
    estimatedCost: r2(estimatedCost),
    tax: round2(tax),
    grossProfit: r2(grossProfit),
    marginPct: r2(marginPct),
    bidSecurity: round2(bidSecurity),
    contractSecurity: round2(contractSecurity),
    cashRequired: r2(cashRequired),
    antidumping: {
      applied: security.applied,
      priceDropPct: security.dropPct,
      advanceForbidden: security.applied && ANTIDUMPING.advanceForbidden
    }
  };

  if (security.applied) {
    warnings.push(security.note);
    // Часть 13 статьи 37: аванса не будет. Для посредника это тяжелее самого
    // обеспечения — всю закупку он финансирует до получения денег от заказчика.
    warnings.push(
      'при таком снижении аванс запрещён законом (ч. 13 ст. 37) — ' +
      'поставку придётся финансировать полностью из своих средств'
    );
  }

  // ---- Ограничения, каждое со своей причиной ----

  let priority;
  let score = 0;

  if (!себестоимостьИзвестна) {
    // Выгода не оценивается — значит и не отсеивает. Оценка «средний»
    // означает «подходит по фильтрам клиента, срок позволяет»; «высокий»
    // без расчёта не ставится никогда.
    score = 50;
    reasons.push('выгода до расчёта не оценивается: себестоимость неизвестна, '
      + 'её даёт разбор документации и поиск поставщиков');
  } else if (marginPct < cfg.minMarginPct) {
    reasons.push(`ожидаемая маржа ${round2(marginPct)}% ниже порога ${cfg.minMarginPct}%`);
    priority = 'пропустить';
  } else {
    // Чем выше маржа сверх порога, тем выше оценка. Потолок — 100.
    score = Math.min(100, Math.round((marginPct / Math.max(cfg.minMarginPct, 1)) * 40));
    reasons.push(`ожидаемая маржа ${round2(marginPct)}% при пороге ${cfg.minMarginPct}%`);
  }

  // Деньги: для посредника это жёсткое ограничение, а не пожелание.
  // Он платит поставщику до того, как получит оплату от заказчика.
  if (cfg.workingCapital !== null && cashRequired !== null && cashRequired > cfg.workingCapital) {
    warnings.push(
      `нужно вынуть из оборота ${Math.round(cashRequired).toLocaleString('ru-RU')} ₽ ` +
      `при лимите ${Math.round(cfg.workingCapital).toLocaleString('ru-RU')} ₽`
    );
    reasons.push('не проходит по оборотным средствам');
    // Тендер может быть выгодным, но неподъёмным. Это отдельная категория:
    // под такой лот можно привлечь партнёра или финансирование.
    priority = priority === 'пропустить' ? 'пропустить' : 'выгодно, но не по карману';
  }

  // Время на подготовку заявки.
  if (tender.deadline) {
    const days = daysBetween(now.toISOString().slice(0, 10), tender.deadline);
    result.daysLeft = days;
    if (days < 0) {
      reasons.push('срок подачи уже прошёл');
      priority = 'пропустить';
    } else if (days < cfg.minDaysToDeadline) {
      warnings.push(`до окончания подачи ${days} дн. — мало времени на подготовку`);
      score = Math.max(0, score - 20);
    }
  } else {
    warnings.push('в карточке нет срока подачи — уточнить по ссылке на закупку');
  }

  if (!priority) {
    if (score >= 70) priority = 'высокий';
    else if (score >= 40) priority = 'средний';
    else priority = 'низкий';
  }

  return {
    priority,
    score,
    // Пока не накоплена статистика по протоколам, любой расчёт — ориентир.
    basis: 'оценка по среднеотраслевым допущениям',
    assumptions: {
      ожидаемоеПадениеЦены: `${Math.round(cfg.expectedDiscount * 100)}%`,
      доляСебестоимости: себестоимостьИзвестна
        ? `${Math.round(cfg.costRatio * 100)}%` : 'не задана — выгода не оценивалась',
      обеспечениеЗаявки: `${cfg.bidSecurityRate * 100}%`,
      обеспечениеКонтракта: `${cfg.contractSecurityRate * 100}%`,
      налог: `${cfg.taxRate * 100}%`
    },
    reasons,
    warnings,
    economics: result
  };
}

/** Короткое пояснение расчёта для клиента: без жаргона и без лишних цифр. */
function explainScore(scored) {
  if (!scored.economics) return scored.reasons.join('; ');
  const e = scored.economics;
  const money = (n) => Math.round(n).toLocaleString('ru-RU') + ' ₽';
  const parts = [
    `НМЦК ${money(e.nmck)}`,
    `ожидаемая цена победы ${money(e.expectedWinPrice)}`
  ];
  if (e.estimatedCost === null) {
    parts.push('себестоимость неизвестна — прибыль покажет расчёт');
  } else {
    parts.push(`себестоимость ${money(e.estimatedCost)}`,
      `прибыль ${money(e.grossProfit)} (${e.marginPct}%)`,
      `потребуется из оборота ${money(e.cashRequired)}`);
  }
  if (typeof e.daysLeft === 'number') parts.push(`до подачи ${e.daysLeft} дн.`);
  return parts.join(', ');
}

module.exports = {
  scoreTender,
  explainScore,
  contractSecurityWithAntidumping,
  DEFAULT_ECONOMICS,
  ANTIDUMPING
};
