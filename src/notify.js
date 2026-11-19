/**
 * Формирование того, что клиент реально увидит: сообщение в Telegram,
 * письмо на почту, строка в его таблице.
 * Без внешних зависимостей — тело функции переносится в Code-ноду n8n как есть.
 *
 * ЭТО НЕ «ОФОРМЛЕНИЕ». Здесь продукт встречается с клиентом, и половина
 * правил надёжности проекта живёт именно тут:
 *
 *   — расчёт выгоды подаётся как ориентир, а не как факт. Ожидаемое снижение
 *     цены задаёт клиент, и ошибка в нём переворачивает вывод о выгодности.
 *     Пока снижение не измерено по нише клиента, уведомление обязано говорить
 *     «прикидка», иначе клиент примет её за расчёт маржи;
 *   — всё, что модель не подтвердила цитатой, помечается явно. Клиент должен
 *     видеть разницу между «в документе написано» и «похоже, что»;
 *   — система ничего не подаёт и не отправляет от имени клиента. В уведомлении
 *     есть ссылка на закупку, но нет ни одного действия, которое система
 *     сделала бы сама;
 *   — алерты о поломках уходят ВЛАДЕЛЬЦУ сервиса, а не клиенту. Клиент не
 *     должен узнавать о сбое парсера из молчания.
 */

const TELEGRAM_LIMIT = 4096;

/**
 * Надпись на кнопке платного расчёта — ОДНО место на весь проект.
 *
 * Найдено 04.10.2026 на первом живом прогоне: кнопка называлась «Посчитать
 * смету», а текст сообщения предлагал нажать «Уточнить». Клиент искал бы
 * кнопку, которой нет. Два написания одного действия расходятся молча —
 * проверки не падают, тесты не ругаются, видит только клиент.
 *
 * Поэтому надпись объявлена здесь и подставляется и в кнопку, и в текст
 * сообщения (`подписьДляЧата` в app/estimate-run.js). Менять — только здесь.
 *
 * Строку `смета:` в callback_data менять нельзя отдельно: её разбирает
 * n8n/воркфлоу-3-кнопка-посчитать.json. Надпись и callback_data — разные вещи,
 * надпись видна клиенту, callback_data видна только n8n.
 *
 * ЧТО ЭТА КНОПКА ЗНАЧИТ (уточнено владельцем 04.10.2026). Это НЕ тариф и не
 * покупка. Деления на бесплатную и платную части нет: «клиент в любом случае
 * платит». Кнопка отвечает на другой вопрос — КАКОЙ из полусотни найденных за
 * неделю тендеров разобрать подробно. Полусотню клиент отсеивает по названию
 * и цене за две секунды, и считать все до единого незачем.
 *
 * Поэтому надпись говорит про тендер, а не про поставщиков и не про смету:
 * расчёт один и полный, и поставщики в нём — один из источников цен.
 */
const КНОПКА_РАСЧЁТА = '📊 Рассчитать тендер';

/** Колонки таблицы клиента. Порядок менять нельзя — он завязан на его формулы. */
const SHEET_COLUMNS = [
  'Обнаружено', 'Номер', 'Закон', 'Статус', 'Объект закупки', 'Заказчик',
  'НМЦК', 'Срок подачи', 'Дней осталось', 'Приоритет', 'Оценка',
  'Ожидаемая прибыль', 'Маржа %', 'Нужно из оборота',
  'Уверенность разбора', 'Что проверить', 'Ссылка'
];

/** Неразрывный пробел: разряды числа не должны переноситься на другую строку. */
const NBSP = ' ';

/**
 * Разбивка числа на разряды.
 *
 * Своя реализация вместо toLocaleString('ru-RU') намеренно. Результат
 * toLocaleString зависит от того, с какой библиотекой локалей собран Node:
 * на урезанной сборке — а именно такие часто стоят на дешёвых VPS — русская
 * локаль отсутствует, и цена печатается как «1,200,000» по-английски.
 * Тест на машине разработчика при этом проходит. Здесь результат одинаков
 * везде и не зависит от окружения.
 */
function groupDigits(n) {
  const sign = n < 0 ? '-' : '';
  const digits = String(Math.abs(Math.round(n)));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += NBSP;
    out += digits[i];
  }
  return sign + out;
}

const money = (n) =>
  typeof n === 'number' && Number.isFinite(n) ? `${groupDigits(n)}${NBSP}₽` : '—';

const dateRu = (iso) => {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
};

/** Экранирование для Telegram в режиме HTML. Пропущенный символ ломает отправку. */
const esc = (s) =>
  String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** Обрезка по границе строки, чтобы сообщение не оборвалось на полуслове. */
function clip(text, limit) {
  if (text.length <= limit) return text;
  const marker = '\n\n… сообщение сокращено, полностью — в таблице';
  const room = limit - marker.length;
  const cut = text.slice(0, room);
  const lastBreak = cut.lastIndexOf('\n');
  return (lastBreak > room * 0.6 ? cut.slice(0, lastBreak) : cut) + marker;
}

/**
 * Дописывает закрывающие теги для всех незакрытых.
 *
 * Telegram разбирает разметку строго: незакрытый тег — не «некрасиво»,
 * а ОТКАЗ принять сообщение целиком. Клиент не получает ничего.
 */
function закрытьТеги(текст) {
  const стек = [];
  const ТЕГИ = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g;
  let m;
  while ((m = ТЕГИ.exec(текст)) !== null) {
    const закрывающий = m[1] === '/';
    const имя = m[2].toLowerCase();
    if (закрывающий) {
      const где = стек.lastIndexOf(имя);
      if (где !== -1) стек.splice(где, 1);
    } else {
      стек.push(имя);
    }
  }
  let из = текст;
  for (let i = стек.length - 1; i >= 0; i--) из += `</${стек[i]}>`;
  return из;
}

/**
 * ПОДПИСЬ К ФАЙЛУ ДЛЯ TELEGRAM — обрезка, не ломающая разметку.
 *
 * Найдено на живом прогоне 09.10.2026. В ноде воркфлоу стояло
 * `String(подпись).slice(0, 1000)` — обрезка по числу знаков. Она разорвала
 * тег пополам, и Telegram отказался принять сообщение целиком:
 * «can't find end tag corresponding to start tag». Клиент не получил ничего —
 * ни текста, ни файла, хотя расчёт был готов и деньги за него потрачены.
 *
 * Предел подписи у Telegram — 1024 знака, у обычного сообщения 4096. Поэтому
 * подпись короткая, а весь расчёт лежит в приложенном файле.
 *
 * Три защиты подряд:
 *   1. обрезка по границе строки, а не посреди слова;
 *   2. срез отодвигается назад, если попал внутрь тега;
 *   3. все оставшиеся открытыми теги закрываются.
 *
 * Функция живёт здесь, а не в ноде воркфлоу, намеренно: код внутри ноды
 * не попадает ни в проверки, ни в историю правок. Это то же правило, из-за
 * которого текст сообщений вынесен из функций, ходящих в сеть.
 */
function подписьДляФайла(текст, предел = 1000) {
  const весь = String(текст || '');
  if (весь.length <= предел) return закрытьТеги(весь);

  const хвост = '\n\n… весь расчёт — в приложенном файле';
  let срез = весь.slice(0, предел - хвост.length);

  // Если срез попал внутрь тега, отодвигаем его до начала этого тега.
  const открыт = срез.lastIndexOf('<');
  if (открыт !== -1 && срез.indexOf('>', открыт) === -1) срез = срез.slice(0, открыт);

  // Режем по границе строки, но только если не теряем больше трети текста.
  const перенос = срез.lastIndexOf('\n');
  if (перенос > срез.length * 0.6) срез = срез.slice(0, перенос);

  return закрытьТеги(срез.trimEnd()) + хвост;
}

const PRIORITY_MARK = {
  'высокий': '🔥',
  'средний': '◆',
  'низкий': '·',
  'пропустить': '✕',
  'выгодно, но не по карману': '💰',
  'требует проверки': '？'
};

/**
 * Собирает всё, что известно о тендере, в один набор строк.
 * Из него потом делаются и Telegram, и письмо, и строка таблицы — чтобы
 * три канала не разъезжались в содержании.
 *
 * @param {object} item
 * @param {object} item.tender карточка из parseSearchPage
 * @param {object} item.scored результат scoreTender
 * @param {object} [item.verified] результат verifyExtraction
 * @param {object} [item.docs] результат parseDocumentsPage
 * @param {Array}  [item.changes] изменения из diffAgainstState
 * @param {Date}   [now]
 */
function collectFacts(item, now = new Date()) {
  const t = item.tender || {};
  const s = item.scored || {};
  const e = s.economics || null;
  const v = item.verified || null;

  const warnings = [...(s.warnings || [])];
  const checks = [];

  if (v) {
    for (const c of v.conflicts || []) {
      checks.push(`${c.field}: в карточке ${c.fromCard}, в документации ${c.fromDocs} — сверить`);
    }
    for (const i of v.issues || []) checks.push(i);
  }
  if (item.docs) {
    for (const f of item.docs.files || []) {
      if (f.isArchive) checks.push(`«${f.name}» — архив, содержимое не разобрано`);
    }
  }

  // Срок подачи: берём из документации, если она его подтвердила и он
  // расходится с карточкой. Более ранний срок безопаснее.
  let deadline = t.deadline;
  let deadlineSource = 'карточка закупки';
  if (v && v.fields && v.fields.deadline && v.fields.deadline.grounded && v.fields.deadline.value) {
    const fromDocs = String(v.fields.deadline.value).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(fromDocs) && (!deadline || fromDocs < deadline)) {
      deadline = fromDocs;
      deadlineSource = 'документация закупки';
    }
  }

  return {
    number: t.number || '—',
    law: t.law || '—',
    status: t.status || '—',
    object: t.object || 'объект закупки не указан в карточке',
    org: t.orgName || '—',
    orgRole: t.orgRole || 'организация',
    price: t.price,
    deadline,
    deadlineSource,
    daysLeft: e && typeof e.daysLeft === 'number' ? e.daysLeft : null,
    priority: s.priority || 'требует проверки',
    score: s.score,
    basis: s.basis || 'оценка',
    profit: e ? e.grossProfit : null,
    marginPct: e ? e.marginPct : null,
    cashRequired: e ? e.cashRequired : null,
    // `разбор` — итог настоящего разбора документации из расчёта. До
    // 16.10.2026 строка «документация не разбиралась» печаталась и тогда,
    // когда смета по документации уже была собрана: она смотрела только на
    // проверку extract.js, которая к расчёту не подключена.
    confidence: v ? v.confidence : (item.разбор || 'документация не разбиралась'),
    reasons: s.reasons || [],
    warnings,
    checks,
    changes: item.changes || [],
    url: t.url || '',
    detectedAt: now.toISOString().slice(0, 10)
  };
}

/**
 * Сообщение в Telegram. Возвращается уже готовым к отправке,
 * вместе с режимом разметки — чтобы обвязка не выбирала его наугад.
 */
function buildTelegram(item, now = new Date()) {
  const f = collectFacts(item, now);
  const lines = [];

  const mark = PRIORITY_MARK[f.priority] || '';
  lines.push(`${mark} <b>${esc(f.priority.toUpperCase())}</b>  ${esc(f.law)}`);
  lines.push(`<b>${esc(f.object)}</b>`);
  lines.push('');

  if (f.changes.length) {
    lines.push('⚠️ <b>Изменения в уже известном тендере:</b>');
    for (const c of f.changes) {
      lines.push(`   ${esc(c.label)}: ${esc(c.from === null ? 'не указан' : c.from)} → <b>${esc(c.to === null ? 'не указан' : c.to)}</b>`);
    }
    lines.push('');
  }

  lines.push(`НМЦК: <b>${esc(money(f.price))}</b>`);
  const daysText = f.daysLeft === null ? '' : ` (осталось ${f.daysLeft} дн.)`;
  lines.push(`Подача до: <b>${esc(dateRu(f.deadline))}</b>${esc(daysText)}`);
  if (f.deadlineSource !== 'карточка закупки') {
    lines.push(`   <i>срок взят из документации — в карточке он другой или отсутствует</i>`);
  }
  lines.push(`${esc(f.orgRole[0].toUpperCase() + f.orgRole.slice(1))}: ${esc(f.org)}`);
  lines.push('');

  // ОРИЕНТИР ПО НАЦЕНКЕ КЛИЕНТА, А НЕ НАША ПРИКИДКА.
  //
  // Раньше здесь печаталась «прикидка по деньгам» из scoring.js. Выяснилось
  // 03.10.2026, что она бесполезна: себестоимость там считалась как доля
  // от НМЦК, поэтому маржа выходила ОДИНАКОВОЙ у всех тендеров — 8,77%.
  // Число, которое не различает закупки, хуже отсутствия числа: оно выглядит
  // расчётом и им не является.
  //
  // Настоящая маржа считается только после разбора документации и поиска
  // поставщиков, а это платный шаг. До него показываем ориентир по ЕГО
  // СОБСТВЕННОЙ обычной наценке — клиент знает её лучше всех, и выдумки тут
  // нет. Для решения «стоит ли тратить расчёт» этого достаточно.
  const наценка = typeof item.typicalMarginPct === 'number' ? item.typicalMarginPct : null;
  if (наценка !== null && typeof f.price === 'number' && f.price > 0) {
    const ориентир = Math.round(f.price * (наценка / 100));
    lines.push(`<b>При вашей обычной марже ${esc(String(наценка))}% — около ${esc(money(ориентир))}</b>`);
    lines.push('   <i>грубый ориентир по вашей наценке, не расчёт. Точная маржа — после разбора документации</i>');
    lines.push('');
  } else if (typeof f.cashRequired === 'number' && f.cashRequired > 0) {
    // Потребность в деньгах показать можно и без расчёта маржи: она зависит
    // от НМЦК и обеспечений, а не от себестоимости.
    lines.push(`Понадобится из оборота ≈ <b>${esc(money(f.cashRequired))}</b>`);
    lines.push('');
  }

  lines.push(`Разбор документации: <b>${esc(f.confidence)}</b>`);
  if (f.checks.length) {
    lines.push('<b>Проверить вручную:</b>');
    for (const c of f.checks.slice(0, 6)) lines.push(`   • ${esc(c)}`);
    if (f.checks.length > 6) lines.push(`   • …и ещё ${f.checks.length - 6}`);
  }
  if (f.warnings.length) {
    for (const w of f.warnings.slice(0, 4)) lines.push(`⚠️ ${esc(w)}`);
  }

  if (f.url) {
    lines.push('');
    lines.push(`<a href="${esc(f.url)}">Открыть закупку на портале</a>`);
  }
  lines.push(`<code>${esc(f.number)}</code>`);

  return {
    parseMode: 'HTML',
    text: clip(lines.join('\n'), TELEGRAM_LIMIT),
    disableWebPagePreview: true,

    // КНОПКА РАСЧЁТА — решение владельца 03.10.2026 по экономике.
    //
    // Разбор документации с поиском поставщиков стоит около 70 ₽ за тендер.
    // Считать все найденные закупки — это 42 тысячи в месяц при плате
    // 15 тысяч с клиента, то есть работа в убыток втрое.
    //
    // При этом клиенту приходит полсотни тендеров в неделю, а подробно его
    // интересуют пять-десять: остальные он отсеивает по названию и цене
    // за две секунды. Платить за расчёты, которые никто не прочитает, незачем.
    //
    // Поэтому расчёт запускается нажатием. В ответе Telegram присылает номер
    // закупки, по нему и считаем. Ограничение Telegram на длину этого поля —
    // 64 байта, реестровый номер с коротким префиксом помещается.
    keyboard: f.number && f.number !== '—'
      ? { inline_keyboard: [[{ text: КНОПКА_РАСЧЁТА, callback_data: 'смета:' + f.number }]] }
      : null,
    // Ссылка нужна для расчёта: по реестровому номеру портал ничего не ищет,
    // адрес карточки восстановить из него нельзя. Сохраняем рядом.
    url: f.url || ''
  };
}

/** Письмо. Тема должна быть понятна без открытия. */
function buildEmail(item, now = new Date()) {
  const f = collectFacts(item, now);
  const short = f.object.length > 60 ? f.object.slice(0, 57) + '…' : f.object;
  const prefix = f.changes.length ? 'Изменение' : 'Тендер';

  const body = [
    `${f.object}`,
    '',
    `Приоритет: ${f.priority}`,
    `Закон: ${f.law}`,
    `Статус: ${f.status}`,
    `Номер: ${f.number}`,
    `${f.orgRole[0].toUpperCase() + f.orgRole.slice(1)}: ${f.org}`,
    `НМЦК: ${money(f.price)}`,
    `Срок подачи: ${dateRu(f.deadline)}${f.daysLeft === null ? '' : ` (осталось ${f.daysLeft} дн.)`}`,
    `Источник срока: ${f.deadlineSource}`,
    ''
  ];

  if (f.changes.length) {
    body.push('ИЗМЕНЕНИЯ В УЖЕ ИЗВЕСТНОМ ТЕНДЕРЕ:');
    for (const c of f.changes) {
      body.push(`  ${c.label}: ${c.from === null ? 'не указан' : c.from} -> ${c.to === null ? 'не указан' : c.to}`);
    }
    body.push('');
  }

  if (f.profit !== null) {
    body.push('ПРИКИДКА ПО ДЕНЬГАМ (не расчёт маржи)');
    body.push(`  ожидаемая прибыль: ${money(f.profit)} (${f.marginPct}%)`);
    body.push(`  понадобится из оборота: ${money(f.cashRequired)}`);
    body.push(`  основание: ${f.basis}`);
    body.push('  Допущение об ожидаемом падении цены на торгах пока не измерено');
    body.push('  на реальной статистике. Проверьте расчёт по своей себестоимости.');
    body.push('');
  }

  body.push(`РАЗБОР ДОКУМЕНТАЦИИ: ${f.confidence}`);
  if (f.checks.length) {
    body.push('Проверить вручную:');
    for (const c of f.checks) body.push(`  - ${c}`);
  }
  if (f.warnings.length) {
    body.push('Предупреждения:');
    for (const w of f.warnings) body.push(`  - ${w}`);
  }
  if (f.reasons.length) {
    body.push('');
    body.push('Почему такой приоритет:');
    for (const r of f.reasons) body.push(`  - ${r}`);
  }
  if (f.url) {
    body.push('');
    body.push(`Закупка на портале: ${f.url}`);
  }
  body.push('');
  body.push('Заявку система не подаёт и ничего не отправляет от вашего имени.');

  return {
    subject: `${prefix}: ${short} — ${money(f.price)}, до ${dateRu(f.deadline)}`,
    body: body.join('\n')
  };
}

/** Строка для таблицы клиента. Порядок значений строго по SHEET_COLUMNS. */
function buildSheetRow(item, now = new Date()) {
  const f = collectFacts(item, now);
  return [
    f.detectedAt,
    f.number,
    f.law,
    f.status,
    f.object,
    f.org,
    f.price === null || f.price === undefined ? '' : f.price,
    f.deadline || '',
    f.daysLeft === null ? '' : f.daysLeft,
    f.priority,
    f.score === null || f.score === undefined ? '' : f.score,
    f.profit === null ? '' : f.profit,
    f.marginPct === null ? '' : f.marginPct,
    f.cashRequired === null ? '' : f.cashRequired,
    f.confidence,
    f.checks.join('; '),
    f.url
  ];
}

/**
 * Всё сразу плюс запись для аудит-лога.
 * Аудит обязателен по правилам проекта: каждый обработанный тендер и каждое
 * уведомление — с меткой времени. Без него нельзя ответить на вопрос
 * «почему клиент не увидел этот тендер».
 */
function buildNotification(item, now = new Date()) {
  const f = collectFacts(item, now);
  return {
    telegram: buildTelegram(item, now),
    email: buildEmail(item, now),
    sheetRow: buildSheetRow(item, now),
    audit: {
      at: now.toISOString(),
      number: f.number,
      priority: f.priority,
      confidence: f.confidence,
      kind: f.changes.length ? 'изменение' : 'новый',
      checksCount: f.checks.length
    }
  };
}

/**
 * Короткая строка расчёта для ежедневного сообщения о тендере.
 *
 * ЗАЧЕМ ОТДЕЛЬНОЙ ФУНКЦИЕЙ. Этот текст собирался внутри `найтиТендеры` в
 * app/search-run.js, а та ходит в сеть — то есть проверить текст было нельзя, и
 * его никто не проверял. Именно поэтому в нём дожило до сервера «Прибыль не
 * менее 0 ₽ (маржа от null%)»: после того как 05.10.2026 убрали выдуманное
 * снижение цены, прибыль стала null, а `Math.round(null)` в JavaScript равен
 * нулю. Ничего не падало, числа выглядели настоящими.
 *
 * ПРАВИЛА ТУТ ТЕ ЖЕ, ЧТО В ПОЛНОМ РАСЧЁТЕ (`подписьДляЧата`):
 *   — предельная цена предложения печатается всегда: она складывается из
 *     расходов и допущений не требует;
 *   — прибыль печатается только если клиент задал ожидаемое снижение. Без него
 *     цены победы не существует, и говорить о прибыли нельзя;
 *   — язык деловой: «рентабельность», а не «маржа» (требование владельца
 *     04.10.2026);
 *   — проценты с запятой, деньги через groupDigits. `toLocaleString('ru-RU')`
 *     нельзя: на урезанной сборке Node русской локали нет, и цена печатается как
 *     «1,200,000», причём у разработчика всё выглядит правильно.
 *
 * @param {object} итоги вывод посчитатьИтоги()
 * @param {object} [estimate] смета — нужна только для числа позиций
 * @returns {string} пустая строка, если считать нечего
 */
// ПО ОДНИМ ЦЕНАМ ОБОСНОВАНИЯ НМЦК ВЫВОДА НЕТ — найдено 16.10.2026.
//
// Ежедневный поиск считает смету без поиска поставщиков, то есть только по
// ценам из обоснования НМЦК. Заказчик и вывел НМЦК из них — сравнивать их с
// НМЦК значит сравнить число с собой же (версия, отвергнутая 04.10.2026).
// Расчёт по кнопке это правило соблюдал, а этот путь печатал «Прибыль 89,7%».
function толькоПотолки(estimate) {
  if (!estimate || !Array.isArray(estimate.rows)) return false;
  const сЦеной = estimate.rows.filter((r) => r.priceForCalc !== null && r.priceForCalc !== undefined);
  return сЦеной.length > 0 && сЦеной.every((r) => r.basis === 'верхняя граница цены');
}

/**
 * Можно ли показать прибыль. Правило владельца 25.10.2026 для Telegram:
 * «не присылай в тг мусор, либо вилку прибыли и маржи, либо ничего».
 * Проверяются флаги, а не значения: `Math.round(null)` = 0.
 */
function прибыльПосчитана(итоги, estimate = null) {
  return !!(итоги && итоги.посчитано && итоги.снижениеЗадано
    && typeof итоги.прибыль === 'number' && typeof итоги.маржа === 'number'
    && !толькоПотолки(estimate));
}

function строкаРасчёта(итоги, estimate = null) {
  if (!итоги || !итоги.посчитано) return '';

  const д = (n) => groupDigits(Math.round(n)) + ' ₽';
  const пр = (n) => (n === null || n === undefined)
    ? '—'
    : (Math.round(n * 10) / 10).toFixed(1).replace('.', ',') + '%';

  const s = [];

  if (толькоПотолки(estimate)) {
    s.push(`Позиций в документации: ${estimate.rows.length}`);
    s.push('<i>Закупочные цены ещё не искались — выгоду покажет расчёт по кнопке</i>');
    return s.join('\n');
  }

  if (итоги.безубыточность !== null && итоги.безубыточность !== undefined) {
    s.push(`<b>Предельная цена предложения: ${д(итоги.безубыточность)}</b>`);
    s.push('<i>ниже этой цены контракт убыточен</i>');
  }

  if (estimate && Array.isArray(estimate.rows)) {
    s.push(`Позиций в расчёте: ${estimate.rows.length}, с ценой: ${estimate.pricedCount}`);
    if (!estimate.complete) s.push('⚠️ расчёт неполный — часть позиций без цены');
  }

  if (прибыльПосчитана(итоги, estimate)) {
    // Вилка (владелец 28.10.2026): основной расчёт - по ЛУЧШЕЙ закупочной цене,
    // нижний край - по худшей закупочной (прибыльХудшая считается от
    // totalWorst, потолок обоснования НМЦК туда не входит).
    const худ = итоги.прибыльХудшая;
    if (typeof худ === 'number' && typeof итоги.маржаХудшая === 'number'
      && Math.round(худ) < Math.round(итоги.прибыль)) {
      s.push(`<b>Прибыль: от ${д(худ)} до ${д(итоги.прибыль)}</b>, `
        + `рентабельность от ${пр(итоги.маржаХудшая)} до ${пр(итоги.маржа)}`);
    } else {
      s.push(`<b>Прибыль: ${д(итоги.прибыль)}</b>, рентабельность ${пр(итоги.маржа)}`);
    }
    s.push(`<i>при снижении ${пр(итоги.снижениеПроцент)} от НМЦК — ваше значение `
      + 'из настроек</i>');
  } else {
    s.push('<i>Прибыль не рассчитана: неизвестно, до какой цены опустятся участники</i>');
  }

  return s.join('\n');
}

/**
 * Короткая сводка, когда тендеров много. Отправляется вместо десятка
 * отдельных сообщений: поток уведомлений, который не читают, равносилен
 * отсутствию уведомлений.
 */
function buildDigest(items, now = new Date()) {
  const facts = items.map((i) => collectFacts(i, now));
  const byPriority = {};
  for (const f of facts) byPriority[f.priority] = (byPriority[f.priority] || 0) + 1;

  const worth = facts.filter((f) => f.priority !== 'пропустить');
  const lines = [`<b>Новых тендеров: ${facts.length}</b>`];
  const order = ['высокий', 'средний', 'выгодно, но не по карману', 'требует проверки', 'низкий', 'пропустить'];
  for (const p of order) {
    if (byPriority[p]) lines.push(`   ${PRIORITY_MARK[p] || '·'} ${esc(p)}: ${byPriority[p]}`);
  }

  if (worth.length) {
    lines.push('');
    lines.push('<b>Стоит посмотреть:</b>');
    for (const f of worth.slice(0, 10)) {
      const title = f.object.length > 70 ? f.object.slice(0, 67) + '…' : f.object;
      lines.push(`• ${esc(title)}`);
      lines.push(`   ${esc(money(f.price))}, до ${esc(dateRu(f.deadline))}${f.url ? ` — <a href="${esc(f.url)}">открыть</a>` : ''}`);
    }
    // Таблицы, на которую здесь ссылался текст, не существует — 16.10.2026.
    if (worth.length > 10) lines.push(`…и ещё ${worth.length - 10}, в сообщении не показаны`);
  }

  return {
    parseMode: 'HTML',
    text: clip(lines.join('\n'), TELEGRAM_LIMIT),
    disableWebPagePreview: true
  };
}

/**
 * Алерт ВЛАДЕЛЬЦУ сервиса, не клиенту.
 *
 * Тихий отказ — самый опасный сценарий проекта. Сломавшийся парсер, пустая
 * выдача там, где её быть не должно, недоступная страница документации —
 * всё это выглядит как штатная работа. Клиент просто перестаёт получать
 * тендеры и узнаёт об этом последним.
 *
 * @param {string} kind короткое название сбоя
 * @param {string} detail что именно произошло
 * @param {object} [context] номер тендера, клиент, адрес — что уместно
 */
function buildOwnerAlert(kind, detail, context = {}, now = new Date()) {
  const lines = [
    '🚨 <b>СБОЙ СЕРВИСА</b>',
    `<b>${esc(kind)}</b>`,
    '',
    esc(detail)
  ];
  const entries = Object.entries(context).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length) {
    lines.push('');
    for (const [k, v] of entries) lines.push(`${esc(k)}: ${esc(v)}`);
  }
  lines.push('');
  lines.push(`<i>${esc(now.toISOString())}</i>`);

  return {
    parseMode: 'HTML',
    text: clip(lines.join('\n'), TELEGRAM_LIMIT),
    disableWebPagePreview: true,
    audience: 'владелец сервиса',
    audit: { at: now.toISOString(), kind, detail, context }
  };
}

module.exports = {
  buildNotification,
  buildTelegram,
  buildEmail,
  buildSheetRow,
  buildDigest,
  строкаРасчёта,
  прибыльПосчитана,
  buildOwnerAlert,
  collectFacts,
  groupDigits,
  подписьДляФайла,
  закрытьТеги,
  SHEET_COLUMNS,
  TELEGRAM_LIMIT,
  КНОПКА_РАСЧЁТА,
  NBSP
};
