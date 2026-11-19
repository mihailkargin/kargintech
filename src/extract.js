/**
 * Извлечение условий закупки из текста документации.
 * Без внешних зависимостей — тело функции переносится в Code-ноду n8n как есть.
 *
 * ЧТО ЗДЕСЬ ЕСТЬ И ЧЕГО НЕТ.
 * Сам вызов модели здесь не делается — он живёт в отдельной ноде n8n на
 * зарубежном сервере. Здесь только то, что можно проверить тестами:
 * сборка запроса, разбор ответа и проверка ответа на вменяемость.
 * Разделение сделано ради требования «модуль разбора изолирован за одним
 * интерфейсом»: смена провайдера модели не должна задевать эти правила.
 *
 * ПОЧЕМУ ОТВЕТ МОДЕЛИ ПРОВЕРЯЕТСЯ, А НЕ ПРИНИМАЕТСЯ НА ВЕРУ.
 * Извлечение смысла из документа на 100% невозможно в принципе. Модель никогда
 * не отвечает «не знаю» охотно: она отвечает уверенно и неправильно. Поэтому
 * каждое значение обязано прийти вместе с цитатой из документа, а код проверяет,
 * что цитата действительно есть в тексте. Значение без подтверждённой цитаты —
 * это не «менее точное значение», это выдумка, и обращаться с ней надо как с
 * выдумкой.
 *
 * ЧТО УХОДИТ В МОДЕЛЬ.
 * Только текст публичной документации, уже прошедший вырезание контактов, и
 * несколько полей карточки закупки. Данные клиента — прайс, номенклатура,
 * маржа, настройки экономики — в запрос не попадают физически: в промпт
 * подставляются только поля из белого списка CARD_FIELDS, а не весь объект.
 * Даже если в функцию передадут обогащённый тендер, лишнее не утечёт.
 */

const { parseDate } = require('./parser');
const { isSafeToSend } = require('./redact');

/** Единственные поля карточки, которые разрешено показывать модели. */
const CARD_FIELDS = ['number', 'law', 'object', 'price', 'deadline'];

/** Поля, ошибка в которых стоит денег. Для них правила строже. */
const CRITICAL = ['deadline', 'nmck', 'bidSecurity', 'contractSecurity'];

/** Что извлекаем. Подписи используются и в промпте, и в уведомлении клиенту. */
const EXTRACTION_FIELDS = {
  deadline: 'окончание подачи заявок (дата и время)',
  deliveryDeadline: 'срок поставки или исполнения контракта',
  deliveryPlace: 'место поставки',
  nmck: 'начальная максимальная цена контракта',
  bidSecurity: 'обеспечение заявки: сумма или процент от НМЦК',
  contractSecurity: 'обеспечение исполнения контракта: сумма или процент',
  penalties: 'штрафы и неустойки за нарушение условий контракта',
  requirements: 'требования к участнику закупки',
  paymentTerms: 'условия и сроки оплаты'
};

/**
 * Пределы, за которыми значение невозможно по закону.
 * Сверено с действующей редакцией 44-ФЗ 30.09.2026 по первоисточнику.
 *
 * ИСПРАВЛЕНА ОШИБКА, найденная при этой сверке. Раньше здесь стоял плоский
 * предел обеспечения заявки 5% при любой НМЦК. По статье 44 предел зависит
 * от начальной цены: до 20 млн это 1%, и только свыше 20 млн — 5%. То есть
 * при НМЦК в миллион обеспечение заявки 3% невозможно по закону, а прежняя
 * проверка его пропускала. Ошибка тихая: неверное обеспечение уходило
 * в расчёт как факт и занижало потребность в оборотных средствах.
 */
const LEGAL = {
  // Статья 44: обеспечение заявки, от 0,5% до предела, зависящего от НМЦК.
  bidSecurity: {
    nmckThreshold: 20000000,
    maxAtOrBelow: 0.01,  // НМЦК до 20 млн включительно
    maxAbove: 0.05,      // НМЦК свыше 20 млн
    min: 0.005
  },
  // Статья 96 часть 6: обеспечение контракта от 0,5% до 30% НМЦК.
  contractSecurity: { min: 0.005, max: 0.30 }
};

/**
 * Предел обеспечения заявки для конкретной НМЦК.
 * Когда НМЦК неизвестна, берём более мягкий предел: задача проверки —
 * ловить невозможное, а не браковать законное из-за нехватки данных.
 */
function bidSecurityLimit(nmck) {
  if (typeof nmck !== 'number' || !Number.isFinite(nmck)) return LEGAL.bidSecurity.maxAbove;
  return nmck > LEGAL.bidSecurity.nmckThreshold
    ? LEGAL.bidSecurity.maxAbove
    : LEGAL.bidSecurity.maxAtOrBelow;
}

/** Оставлено для обратной совместимости: прежнее имя, мягкий предел. */
const PLAUSIBLE = {
  bidSecurityMaxRatio: LEGAL.bidSecurity.maxAbove,
  contractSecurityMaxRatio: LEGAL.contractSecurity.max
};

// ---------------------------------------------------------------- разбор чисел

/**
 * Сумма из текста документа или из ответа модели.
 * Принимает и русское написание «12 000,50 руб.», и машинное «12000.50».
 *
 * Разделитель определяется по последнему знаку: если после него две цифры и
 * это единственный такой знак — он десятичный, иначе это разделитель разрядов.
 * Иначе «1.200.000» превратилось бы в 1.2, а «12000.50» — в 1200050.
 *
 * @returns {number|null} null, если числа нет вовсе
 */
function parseAmount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (raw === null || raw === undefined) return null;

  const text = String(raw).replace(/ /g, ' ');
  // Окончание задаётся [а-яё], а не \w: \w не считает буквами кириллицу, и
  // «не предусмотрено» переставало распознаваться — сумма уходила как «нет
  // данных» вместо честного нуля.
  if (/^\s*(?:не\s+требуется|не\s+предусмотрен[а-яё]*|отсутствует|нет)\s*$/i.test(text)) return 0;

  const digits = text.match(/-?\d[\d\s.,]*/);
  if (!digits) return null;

  let s = digits[0].replace(/\s/g, '');
  const lastSep = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
  if (lastSep !== -1) {
    const tail = s.slice(lastSep + 1);
    const sepCount = (s.match(/[.,]/g) || []).length;
    if (tail.length <= 2 && sepCount === 1) {
      s = s.slice(0, lastSep).replace(/[.,]/g, '') + '.' + tail;
    } else {
      s = s.replace(/[.,]/g, '');
    }
  }
  const value = parseFloat(s);
  return Number.isFinite(value) ? value : null;
}

/**
 * Обеспечение: в документации оно пишется то суммой, то процентом от НМЦК.
 * @param {*} raw значение из ответа модели
 * @param {number|null} nmck начальная цена, чтобы развернуть процент в сумму
 * @returns {{amount: number|null, ratio: number|null, required: boolean, fromPercent: boolean}}
 */
function parseSecurity(raw, nmck) {
  const text = raw === null || raw === undefined ? '' : String(raw);
  const blank = { amount: null, ratio: null, required: false, fromPercent: false };

  if (!text.trim()) return blank;
  if (/не\s+требуется|не\s+предусмотрен|отсутствует/i.test(text)) {
    return { amount: 0, ratio: 0, required: false, fromPercent: false };
  }

  const percent = text.match(/(\d+(?:[.,]\d+)?)\s*%/);
  if (percent) {
    const ratio = parseFloat(percent[1].replace(',', '.')) / 100;
    const amount = typeof nmck === 'number' ? Math.round(nmck * ratio * 100) / 100 : null;
    return { amount, ratio, required: ratio > 0, fromPercent: true };
  }

  const amount = parseAmount(text);
  if (amount === null) return blank;
  const ratio = typeof nmck === 'number' && nmck > 0 ? amount / nmck : null;
  return { amount, ratio, required: amount > 0, fromPercent: false };
}

// ------------------------------------------------------------- сборка запроса

/** Приводит текст к виду, в котором цитату можно честно сравнить с документом. */
function normalizeForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»""„“]/g, '"')
    .replace(/[­‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Собирает запрос к модели.
 *
 * ЗАЩЁЛКА БЕЗОПАСНОСТИ: если в тексте остались контакты, запрос не собирается
 * вовсе. Отправка — необратимое действие, откатить утечку нельзя, поэтому
 * проверка стоит здесь, а не в виде пожелания в документации.
 *
 * @param {object} tender карточка закупки
 * @param {string} documentText текст документации ПОСЛЕ вырезания контактов
 * @returns {{ok: boolean, blocked?: Array<string>, system?: string, user?: string}}
 */
function buildExtractionRequest(tender, documentText) {
  const safety = isSafeToSend(documentText);
  if (!safety.safe) {
    return { ok: false, blocked: safety.findings };
  }
  if (!String(documentText || '').trim()) {
    return { ok: false, blocked: ['текст документации пуст — нечего разбирать'] };
  }

  // Только белый список. Весь объект тендера в промпт не попадает никогда:
  // к нему на более поздних шагах приклеиваются расчёты по данным клиента.
  const card = {};
  for (const key of CARD_FIELDS) {
    if (tender && tender[key] !== undefined && tender[key] !== null) card[key] = tender[key];
  }

  const fieldList = Object.entries(EXTRACTION_FIELDS)
    .map(([key, label]) => `  "${key}" — ${label}`)
    .join('\n');

  const system = [
    'Ты извлекаешь условия закупки из официальной документации.',
    '',
    'Правила, обязательные к исполнению:',
    '1. Отвечай ТОЛЬКО тем, что буквально написано в тексте. Ничего не выводи по смыслу и не дополняй типичной практикой.',
    '2. К каждому значению прилагай quote — дословную цитату из текста, в которой это значение видно. Цитата копируется посимвольно, без пересказа.',
    '3. Если значения в тексте нет — value: null, confidence: "нет данных". Пустой ответ лучше правдоподобной догадки.',
    '4. confidence: "высокая" — написано прямо; "средняя" — требует толкования; "нет данных" — не найдено.',
    '5. Суммы — цифрами, как в документе. Даты — в формате ГГГГ-ММ-ДД.',
    '6. Ответ — один объект JSON без пояснений до и после.'
  ].join('\n');

  const user = [
    'Карточка закупки с портала (для сверки, не источник истины):',
    JSON.stringify(card, null, 2),
    '',
    'Извлеки поля:',
    fieldList,
    '  "items" — позиции лота: массив объектов {name, quantity, unit, quote}',
    '',
    'Формат каждого поля: {"value": ..., "quote": "...", "confidence": "..."}',
    '',
    '--- НАЧАЛО ДОКУМЕНТАЦИИ ---',
    String(documentText),
    '--- КОНЕЦ ДОКУМЕНТАЦИИ ---'
  ].join('\n');

  return { ok: true, system, user };
}

/**
 * Разбирает ответ модели в объект. Терпим к обёрткам вокруг JSON, потому что
 * модель иногда добавляет ```json или вводную фразу, и падать из-за этого
 * глупо. К содержимому при этом доверия нет — его проверяет verifyExtraction.
 *
 * @returns {{ok: boolean, data?: object, error?: string}}
 */
function parseExtraction(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: 'модель вернула пустой ответ' };

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  let candidate = fenced ? fenced[1].trim() : text;

  if (!candidate.startsWith('{')) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) return { ok: false, error: 'в ответе модели нет объекта JSON' };
    candidate = candidate.slice(start, end + 1);
  }

  try {
    const data = JSON.parse(candidate);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: 'ответ модели — не объект' };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: `ответ модели не разбирается как JSON: ${e.message}` };
  }
}

// ---------------------------------------------------------------- проверка

/** Приводит поле к единому виду, что бы модель ни вернула. */
function normalizeField(entry) {
  if (entry === null || entry === undefined) return { value: null, quote: '', confidence: 'нет данных' };
  if (typeof entry !== 'object' || Array.isArray(entry)) {
    // Модель ответила значением без обёртки — цитаты нет, а значит нет и опоры.
    return { value: entry, quote: '', confidence: 'средняя' };
  }
  return {
    value: entry.value === undefined ? null : entry.value,
    quote: typeof entry.quote === 'string' ? entry.quote : '',
    confidence: typeof entry.confidence === 'string' ? entry.confidence : 'средняя'
  };
}

/**
 * Проверяет ответ модели: подтверждена ли каждая цитата, сходятся ли числа
 * с карточкой, возможны ли полученные значения физически.
 *
 * @param {object} extracted результат parseExtraction
 * @param {object} tender карточка из parseSearchPage
 * @param {string} documentText тот же текст, что уходил в модель
 * @param {Date} now точка отсчёта
 */
function verifyExtraction(extracted, tender, documentText, now = new Date()) {
  const haystack = normalizeForMatch(documentText);
  const conflicts = [];
  const issues = [];
  const ungrounded = [];
  const fields = {};

  const isGrounded = (quote) => {
    if (!quote) return false;
    // Модель иногда обрезает длинную цитату многоточием — сравниваем начало.
    const cleaned = normalizeForMatch(quote).replace(/\s*(?:\.{3}|…)\s*$/, '');
    if (cleaned.length < 8) return false;
    return haystack.includes(cleaned);
  };

  for (const key of Object.keys(EXTRACTION_FIELDS)) {
    const f = normalizeField(extracted[key]);
    const grounded = isGrounded(f.quote);
    fields[key] = { ...f, grounded, source: 'документация' };

    if (f.value !== null && !grounded) {
      ungrounded.push(`${key}: цитата не найдена в документе`);
      if (CRITICAL.includes(key)) {
        issues.push(`${EXTRACTION_FIELDS[key]}: значение есть, но цитата в документе не найдена — доверять нельзя`);
      }
    }
  }

  // ---- Перекрёстная сверка с карточкой ----
  // Требование из AGENTS.md: критичные числа извлекаются двумя путями.
  // Расхождение — это флаг, а не повод выбрать одно из значений наугад.

  const docNmck = parseAmount(fields.nmck.value);
  if (docNmck !== null && typeof tender.price === 'number') {
    // Копейки в документе и в карточке иногда округлены по-разному.
    if (Math.abs(docNmck - tender.price) > 1) {
      conflicts.push({
        field: 'НМЦК',
        fromCard: tender.price,
        fromDocs: docNmck,
        note: 'начальная цена в карточке и в документации не совпадает'
      });
    }
  }

  const docDeadline = parseDate(String(fields.deadline.value || '')) ||
    (/^\d{4}-\d{2}-\d{2}/.test(String(fields.deadline.value || ''))
      ? String(fields.deadline.value).slice(0, 10)
      : null);
  if (docDeadline && tender.deadline && docDeadline !== tender.deadline) {
    conflicts.push({
      field: 'окончание подачи заявок',
      fromCard: tender.deadline,
      fromDocs: docDeadline,
      note: 'срок подачи в карточке и в документации не совпадает — подавать заявку по наиболее раннему'
    });
  }
  // Карточка 223-ФЗ способом «Иной способ» может не содержать срока вовсе.
  // Тогда документация — единственный источник, и это не конфликт, а находка.
  if (docDeadline && !tender.deadline) {
    fields.deadline.note = 'в карточке срока не было, значение взято только из документации';
  }

  // ---- Проверки на правдоподобность ----

  const nmck = typeof tender.price === 'number' ? tender.price : docNmck;
  const bid = parseSecurity(fields.bidSecurity.value, nmck);
  const contract = parseSecurity(fields.contractSecurity.value, nmck);

  const pct = (ratio) => Math.round(ratio * 1000) / 10;

  if (bid.amount !== null && nmck !== null) {
    // Предел зависит от НМЦК: до 20 млн — 1%, свыше — 5% (ст. 44 44-ФЗ).
    const limit = bidSecurityLimit(nmck);
    if (bid.amount > nmck) issues.push('обеспечение заявки больше НМЦК — так не бывает');
    else if (bid.ratio !== null && bid.ratio > limit) {
      issues.push(
        `обеспечение заявки ${pct(bid.ratio)}% от НМЦК — выше предела ${pct(limit)}%, ` +
        `установленного статьёй 44 для закупок ${nmck > LEGAL.bidSecurity.nmckThreshold ? 'свыше' : 'до'} ` +
        `${LEGAL.bidSecurity.nmckThreshold / 1000000} млн ₽; проверить, не перепутано ли с обеспечением контракта`
      );
    } else if (bid.required && bid.ratio !== null && bid.ratio < LEGAL.bidSecurity.min) {
      issues.push(
        `обеспечение заявки ${pct(bid.ratio)}% от НМЦК — ниже установленного законом минимума ` +
        `${pct(LEGAL.bidSecurity.min)}%, вероятно потерян разряд`
      );
    }
  }
  if (contract.amount !== null && nmck !== null) {
    if (contract.amount > nmck) issues.push('обеспечение контракта больше НМЦК — так не бывает');
    else if (contract.ratio !== null && contract.ratio > LEGAL.contractSecurity.max) {
      issues.push(
        `обеспечение контракта ${pct(contract.ratio)}% от НМЦК — выше предела ` +
        `${pct(LEGAL.contractSecurity.max)}%, установленного частью 6 статьи 96`
      );
    } else if (contract.required && contract.ratio !== null && contract.ratio < LEGAL.contractSecurity.min) {
      issues.push(
        `обеспечение контракта ${pct(contract.ratio)}% от НМЦК — ниже установленного законом минимума ` +
        `${pct(LEGAL.contractSecurity.min)}%, вероятно потерян разряд`
      );
    }
  }

  const today = now.toISOString().slice(0, 10);
  if (docDeadline && docDeadline < today) {
    issues.push('срок подачи заявок по документации уже прошёл');
  }
  const docDelivery = parseDate(String(fields.deliveryDeadline.value || '')) ||
    (/^\d{4}-\d{2}-\d{2}/.test(String(fields.deliveryDeadline.value || ''))
      ? String(fields.deliveryDeadline.value).slice(0, 10)
      : null);
  if (docDelivery && docDeadline && docDelivery < docDeadline) {
    issues.push('срок поставки раньше срока подачи заявок — значения перепутаны');
  }

  // ---- Позиции лота ----

  const rawItems = Array.isArray(extracted.items) ? extracted.items : [];
  const items = rawItems.map((it, i) => {
    const name = it && typeof it.name === 'string' ? it.name.trim() : '';
    const quantity = parseAmount(it && it.quantity);
    const quote = it && typeof it.quote === 'string' ? it.quote : '';
    const problems = [];
    if (!name) problems.push('нет наименования');
    if (quantity === null) problems.push('количество не распознано');
    else if (quantity <= 0) problems.push('количество меньше или равно нулю');
    if (!isGrounded(quote)) problems.push('цитата не найдена в документе');
    if (problems.length) issues.push(`позиция ${i + 1}: ${problems.join(', ')}`);
    return {
      name,
      quantity,
      unit: it && typeof it.unit === 'string' ? it.unit.trim() : '',
      quote,
      grounded: isGrounded(quote),
      problems
    };
  });
  if (rawItems.length === 0) {
    issues.push('позиции лота не извлечены — сверка с прайсом невозможна');
  }

  // ---- Итоговая уверенность ----

  let confidence;
  if (conflicts.length > 0 || issues.length > 0) {
    confidence = 'требует проверки';
  } else if (CRITICAL.some((k) => fields[k].confidence === 'средняя' && fields[k].value !== null)) {
    confidence = 'средняя';
  } else {
    confidence = 'высокая';
  }

  return {
    confidence,
    fields,
    items,
    security: { bid, contract },
    conflicts,
    issues,
    ungrounded
  };
}

/**
 * Настройки экономики, уточнённые по документации.
 *
 * До разбора документации обеспечение считалось по средней ставке — это было
 * помечено как допущение в scoring.js. Здесь допущение заменяется фактом:
 * возвращённый объект передаётся в scoreTender вторым аргументом.
 * Если факта нет или он не заслуживает доверия — не возвращаем ничего, и
 * расчёт остаётся на допущениях. Подменять оценку выдумкой хуже, чем оставить
 * оценку оценкой.
 *
 * @param {object} verified результат verifyExtraction
 * @returns {object} перекрытия для scoreTender; пустой объект, если фактов нет
 */
function factualEconomics(verified) {
  const over = {};
  if (verified.confidence === 'требует проверки') return over;

  const { bid, contract } = verified.security;
  if (bid.ratio !== null && verified.fields.bidSecurity.grounded) {
    over.bidSecurityRate = bid.ratio;
  }
  if (contract.ratio !== null && verified.fields.contractSecurity.grounded) {
    over.contractSecurityRate = contract.ratio;
  }
  return over;
}

/** Короткая сводка для человека: что извлечено и чему верить. */
function explainExtraction(verified) {
  const parts = [`уверенность: ${verified.confidence}`];
  if (verified.conflicts.length) {
    parts.push(
      'расхождения — ' +
      verified.conflicts.map((c) => `${c.field}: карточка ${c.fromCard}, документация ${c.fromDocs}`).join('; ')
    );
  }
  if (verified.issues.length) parts.push('проверить — ' + verified.issues.join('; '));
  const found = Object.entries(verified.fields)
    .filter(([, f]) => f.value !== null && f.grounded)
    .map(([k]) => k);
  parts.push(`подтверждено полей: ${found.length} из ${Object.keys(EXTRACTION_FIELDS).length}`);
  if (verified.items.length) parts.push(`позиций лота: ${verified.items.length}`);
  return parts.join('. ');
}

module.exports = {
  buildExtractionRequest,
  parseExtraction,
  verifyExtraction,
  factualEconomics,
  explainExtraction,
  parseAmount,
  parseSecurity,
  bidSecurityLimit,
  EXTRACTION_FIELDS,
  CARD_FIELDS,
  LEGAL,
  PLAUSIBLE
};
