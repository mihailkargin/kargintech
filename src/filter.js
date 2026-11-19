/**
 * Отбор тендеров по фильтрам клиента.
 *
 * Принцип: ошибка отсева дороже ошибки лишнего показа. Пропущенный тендер —
 * это потерянный контракт, а лишний в списке — несколько секунд времени.
 * Поэтому фильтр склоняется к включению, а каждое решение об отсеве
 * сопровождается причиной и попадает в журнал, а не происходит молча.
 *
 * Ключевые слова сопоставляются как подстроки в нижнем регистре: клиент задаёт
 * основу слова («бумаг»), она ловит «бумага», «бумаги», «бумагу». Это
 * предсказуемо и объяснимо, в отличие от морфологического анализа.
 */

/** Приведение к виду, пригодному для сравнения: регистр, ё, пробелы. */
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е') // ё -> е
    .replace(/\s+/g, ' ')
    .trim();
}

function основа(слово) {
  const w = String(слово || '').toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9-]/g, '');
  if (w.length <= 4) return w;
  const м = w.match(/^(.+?)(ами|ями|ого|его|ому|ему|ыми|ими|ая|яя|ое|ее|ые|ие|ый|ий|ой|ую|юю|ых|их|ым|им|ом|ем|ов|ев|ах|ях|ам|ям|ы|и|а|я|о|е|у|ю|ь|й)$/);
  return м && м[1].length >= 4 ? м[1] : w;
}

function совпадениеСтоп(текст, стоп) {
  const слова = normalize(стоп).split(' ').map(основа).filter(Boolean);
  if (!слова.length) return false;
  const шаблон = слова.map((с) => `${с}[а-яa-z]*`).join('\\s+');
  return new RegExp(`(?<![а-яa-z0-9])${шаблон}`, 'i').test(normalize(текст));
}

/**
 * ОСНОВА В НАЧАЛЕ СЛОВА (23.10.2026). С полным потоком отбор идёт по 71
 * тысяче закупок, и подстрока ловила чужое: «провод» - в «водопровод»,
 * «газопровод»; «стол» - в «столовой» (158 закупок продуктов «для столовой»
 * у одной компании). Теперь основа обязана начинать слово, а короткой
 * основе (до 4 букв) запрещено продолжение прилагательным на «-ов-»
 * («столовая», «столовой»). Список разрешённых окончаний не годится: короткие
 * основы бывают и нарочно обрезанными («бума», «блан» ловит «бланочная»).
 * Фраза с пробелом ищется как раньше, подстрокой.
 */
const БУКВА = /[а-яa-z0-9]/;
const ШИРОКИЕ_ГРУППЫ = new Set(['32.99', '28.29']);
const ЧУЖОЕ_ПРОДОЛЖЕНИЕ = /^ов(ая|ой|ую|ые|ых|ым|ыми|ое|ого|ому|ом|ою)$/;
// Короткая основа из ЦЕЛОГО слова фразы клиента («столы офисные» → «стол») -
// только окончания существительного: иначе «столбы», «столбнячный»,
// «столицы». Нарочно обрезанная («бума» из «бумага», «блан») - любое
// продолжение, кроме «-овая/-овой».
const ОКОНЧАНИЯ = new Set(['', 'а', 'у', 'ом', 'е', 'ы', 'ов', 'ам', 'ами', 'ах', 'и', 'ей', 'ям', 'ями', 'ях', 'я', 'ю', 'ем', 'ой', 'ою', 'ь']);
function строгаяОснова(основа, словаФраз) {
  for (const w of словаФраз) if (w.startsWith(основа) && ОКОНЧАНИЯ.has(w.slice(основа.length))) return true;
  return false;
}
function естьОснова(текст, основа, строгая = false) {
  if (!основа) return false;
  if (основа.includes(' ')) return текст.includes(основа);
  let с = 0;
  for (;;) {
    const i = текст.indexOf(основа, с);
    if (i === -1) return false;
    с = i + 1;
    if (i > 0 && БУКВА.test(текст[i - 1])) continue;
    if (основа.length > 4) return true;
    let конец = i + основа.length;
    while (конец < текст.length && БУКВА.test(текст[конец])) конец++;
    const продолжение = текст.slice(i + основа.length, конец);
    if (строгая ? ОКОНЧАНИЯ.has(продолжение) : !ЧУЖОЕ_ПРОДОЛЖЕНИЕ.test(продолжение)) return true;
  }
}

/**
 * @typedef {object} FilterConfig
 * @property {string[]} [keywords]   основы слов; достаточно одного совпадения
 * @property {string[]} [phrases]    фразы поиска клиента - чтобы отличить короткую основу-слово («стол») от обрезанной («бума»)
 * @property {string[]} [okpd]       коды ОКПД2 клиента («17.12», «10»): совпадение кода заменяет ключевое слово
 * @property {string[]} [stopWords]  основы слов; любое совпадение исключает тендер
 * @property {number}   [minPrice]   нижняя граница НМЦК включительно
 * @property {number}   [maxPrice]   верхняя граница НМЦК включительно
 * @property {string[]} [laws]       например ['44-ФЗ']
 * @property {string[]} [statuses]   например ['Подача заявок']
 * @property {boolean}  [requireDeadline] отсеивать карточки без срока подачи
 */

/**
 * Проверяет тендер по фильтрам клиента.
 * @param {object} tender карточка из parseSearchPage
 * @param {FilterConfig} config
 * @returns {{passed: boolean, reasons: string[], matched: string[]}}
 */
function matchesFilters(tender, config = {}) {
  const reasons = [];
  const matched = [];

  // Ключевые слова - по объекту закупки. Название заказчика - только если
  // объекта нет (электронный магазин, ч. 12 ст. 93): иначе «пожарн» пропускало
  // ВСЕ закупки пожарных частей - топливо, продукты (полный поток, 23.10.2026).
  // Короткие аббревиатуры в названии организации не считаются: «СКС» и «СКУД»
  // могут быть именами компаний, а не предметом закупки.
  // Стоп-слова - по обоим: лишнее отсеять безопаснее, чем пропустить.
  const объект = normalize(tender.object);
  const гдеИскать = объект || normalize(tender.orgName);
  const haystack = normalize(`${tender.object} ${tender.orgName}`);

  const keywords = (config.keywords || []).map(normalize).filter(Boolean);
  // КОД ОКПД2 - ВТОРОЙ ПУТЬ В ЛЕНТУ (22.10.2026, решение владельца «совмещать,
  // чтобы не пропускать выгодных»). Закупка проходит, если в названии есть
  // ключевое слово ИЛИ её код ОКПД2 входит в коды клиента: «Поставка товаров
  // для нужд школы» с кодом 17.12 не содержит слова «бумага», но это бумага.
  // Код клиента - группа («17.12») или класс («10»): сравнение по началу.
  // Широкие группы («прочие изделия», «прочее оборудование») на уровне группы
  // ловят что угодно - ёлки, трости, маски в ленте канцтоваров (23.10.2026).
  // Убраны из категорий, а здесь не действуют и в уже сохранённых настройках.
  const кодыКлиента = (config.okpd || []).map((к) => String(к).trim()).filter((к) => к && !ШИРОКИЕ_ГРУППЫ.has(к));
  const кодыЗакупки = [tender.okpdGroup, ...(tender.okpdGroups || [])].filter(Boolean).map(String);
  const поКоду = кодыКлиента.length
    // Код клиента точнее группы закупки («17.12.14» при известной группе
    // «17.12») - совпадение: у закупки 44-ФЗ из ИКЗ известна только группа.
    ? кодыЗакупки.find((к) => кодыКлиента.some((кк) => к === кк || к.startsWith(кк + '.') || кк.startsWith(к + '.'))) || null
    : null;
  if (keywords.length) {
    const словаФраз = (config.phrases || []).flatMap((ф) => normalize(ф).split(/[^а-яa-z0-9]+/)).filter(Boolean);
    const hits = keywords.filter(k => (объект || k.length > 4) && естьОснова(гдеИскать, k, k.length <= 4 && строгаяОснова(k, словаФраз)));
    if (hits.length) matched.push(...hits);
    else if (поКоду) matched.push(`ОКПД2 ${поКоду}`);
    else reasons.push('нет совпадений по ключевым словам');
  } else if (кодыКлиента.length && !поКоду) {
    reasons.push('код ОКПД2 не из ваших категорий');
  }

  const stopWords = (config.stopWords || []).map(normalize).filter(Boolean);
  const stopHits = stopWords.filter(s => совпадениеСтоп(haystack, s));
  if (stopHits.length) reasons.push(`стоп-слова: ${stopHits.join(', ')}`);

  if (typeof config.minPrice === 'number') {
    if (tender.price === null) {
      // Цена не распознана — не отсеиваем, а отдаём человеку.
      // Молча выбросить тендер только потому, что не разобрали цену, нельзя.
      reasons.push('НМЦК не распознана, нижняя граница не проверена');
    } else if (tender.price < config.minPrice) {
      reasons.push(`НМЦК ${tender.price} ниже порога ${config.minPrice}`);
    }
  }

  if (typeof config.maxPrice === 'number' && tender.price !== null && tender.price > config.maxPrice) {
    reasons.push(`НМЦК ${tender.price} выше порога ${config.maxPrice}`);
  }

  if (Array.isArray(config.laws) && config.laws.length) {
    const law = normalize(tender.law);
    if (!config.laws.some(l => law.includes(normalize(l)))) {
      reasons.push('другой закон');
    }
  }

  if (Array.isArray(config.statuses) && config.statuses.length) {
    const status = normalize(tender.status);
    if (!config.statuses.some(s => status.includes(normalize(s)))) {
      reasons.push(`статус «${tender.status}»`);
    }
  }

  // ЗАКУПКА У ЕДИНСТВЕННОГО ПОСТАВЩИКА — участвовать нельзя, поставщик уже
  // выбран, спецификации в документах нет. Отсекается всегда, без настройки
  // (тест «слаботочка» 20.10.2026: 4 таких из 126 шли в разбор и клиенту).
  if (/единственн[а-яё]*\s+поставщик/i.test(String(tender.law || '') + ' ' + String(tender.method || ''))) {
    reasons.push('закупка у единственного поставщика — участвовать нельзя');
  }

  if (config.requireDeadline && !tender.deadline) {
    reasons.push('нет срока подачи заявок');
  }

  // «НМЦК не распознана» — повод показать тендер человеку, а не отбросить его.
  const onlySoftReasons = reasons.length > 0 && reasons.every(r => r.startsWith('НМЦК не распознана'));

  return {
    passed: reasons.length === 0 || onlySoftReasons,
    needsReview: onlySoftReasons,
    reasons,
    matched
  };
}

/**
 * Применяет фильтр к списку. Отсеянные не теряются, а возвращаются
 * с причинами — это требование журналируемости.
 * @param {Array<object>} tenders
 * @param {FilterConfig} config
 */
function applyFilters(tenders, config = {}) {
  const passed = [];
  const rejected = [];
  for (const tender of tenders) {
    const verdict = matchesFilters(tender, config);
    if (verdict.passed) {
      passed.push({ ...tender, matchedKeywords: verdict.matched, needsReview: verdict.needsReview, filterNotes: verdict.reasons });
    } else {
      rejected.push({ number: tender.number, object: tender.object, reasons: verdict.reasons });
    }
  }
  return { passed, rejected };
}

/**
 * ПОВТОРНАЯ ПРОВЕРКА ФИЛЬТРОВ ПО СОДЕРЖИМОМУ ТЗ — порядок владельца 16.10.2026:
 * «ищешь тендер по фильтрам, потом смотришь ТЗ и фильтры».
 *
 * Карточка показывает только объект закупки одной строкой. Что поставлять на
 * самом деле, видно по позициям: «Поставка канцелярских товаров» может
 * содержать «ремонт оргтехники» отдельной позицией.
 *
 * Проверяются только СТОП-СЛОВА. Ключевые слова по позициям не проверяются
 * намеренно: «Антистеплер» и «Дырокол» не содержат основу «канцеляр», и отсев
 * по ним выбросил бы весь рынок клиента. Ошибка отсева дороже лишнего показа.
 *
 * @param {string[]} наименования позиций из разбора документации
 * @param {FilterConfig} config фильтр клиента
 * @returns {{прошёл: boolean, причины: string[], найдено: Array<{слово: string, позиция: string}>}}
 */
function проверкаПоТЗ(наименования, config = {}) {
  const стоп = (config.stopWords || []).map(normalize).filter(Boolean);
  const найдено = [];
  for (const имя of наименования || []) {
    const н = normalize(имя);
    for (const с of стоп) {
      if (совпадениеСтоп(н, с)) найдено.push({ слово: с, позиция: String(имя).trim() });
    }
  }
  const причины = найдено.slice(0, 3).map((н) => `в ТЗ стоп-слово «${н.слово}»: «${н.позиция.slice(0, 60)}»`);
  if (найдено.length > 3) причины.push(`и ещё ${найдено.length - 3}`);
  return { прошёл: найдено.length === 0, причины, найдено };
}

module.exports = { matchesFilters, applyFilters, normalize, основа, естьОснова, совпадениеСтоп, проверкаПоТЗ };
