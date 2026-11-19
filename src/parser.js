/**
 * Разбор страницы результатов поиска ЕИС (zakupki.gov.ru).
 * Без внешних зависимостей — тело функции переносится в Code-ноду n8n как есть.
 */

const { группаИзИкз } = require('./okpd');
const { регионЗаказчика } = require('./region');

const RUB = '₽';
const NBSP = ' ';

function decode(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8381;/g, RUB)
    .replace(/&quot;/g, '"')
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // Числовые сущности (&#034; и т.п.): новая вёрстка 223-ФЗ кавычки в
    // имени заказчика пишет именно числом, именованных там нет.
    .replace(/&#(\d{1,5});/g, (_, к) => String.fromCodePoint(Number(к)))
    .replace(new RegExp(NBSP, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function grab(text, pattern) {
  const m = text.match(pattern);
  return m ? decode(m[1]) : '';
}

/**
 * Позиция закрывающей скобки открывающего тега, начинающегося в tagStart.
 *
 * Нельзя искать её шаблоном [^>]*: в разметке ЕИС есть атрибут data-tooltip,
 * внутри которого лежит HTML со своими угловыми скобками. Наивный шаблон
 * обрывается на них и утаскивает в результат текст подсказки — например,
 * имя приложенного файла приезжает продублированным. Поэтому идём посимвольно,
 * отслеживая кавычки.
 *
 * Функция вынесена отдельно и экспортируется: та же ловушка есть на странице
 * документации закупки, и чинить её надо в одном месте, а не в двух.
 *
 * @param {string} text разметка
 * @param {number} tagStart позиция символа '<'
 * @returns {number} позиция '>' или -1, если тег не закрыт
 */
function tagEnd(text, tagStart) {
  let i = tagStart;
  let quote = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
    i++;
  }
  return -1;
}

/**
 * Содержимое элемента, найденного по имени класса.
 *
 * @param {string} text фрагмент разметки
 * @param {string} className имя класса без точки
 * @param {number} from с какой позиции искать
 * @returns {{value: string, end: number}} value — очищенный текст, end — позиция после </div>
 */
function elementText(text, className, from = 0) {
  const idx = text.indexOf(className, from);
  if (idx === -1) return { value: '', end: -1 };

  const tagStart = text.lastIndexOf('<', idx);
  if (tagStart === -1) return { value: '', end: -1 };

  const i = tagEnd(text, tagStart);
  if (i === -1) return { value: '', end: -1 };

  const rest = text.slice(i + 1);
  const closeAt = rest.indexOf('</div>');
  const body = closeAt === -1 ? rest : rest.slice(0, closeAt);
  return { value: decode(body), end: closeAt === -1 ? text.length : i + 1 + closeAt + 6 };
}

const textOf = (text, className) => elementText(text, className).value;

/** Пары «подпись → значение» для блоков, идущих последовательно. */
function collectPairs(text, titleClass, valueClass) {
  const pairs = new Map();
  let pos = 0;
  while (true) {
    const title = elementText(text, titleClass, pos);
    if (title.end === -1) break;
    const value = elementText(text, valueClass, title.end);
    if (value.end === -1) break;
    if (title.value && !pairs.has(title.value)) pairs.set(title.value, value.value);
    pos = value.end;
  }
  return pairs;
}

/** "7 010,10 ₽" -> 7010.1 ; пустая или нечитаемая строка -> null */
function parseMoney(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(new RegExp(NBSP, 'g'), '').replace(/[^\d,.-]/g, '');
  if (!cleaned) return null;
  const normalized = cleaned.replace(/\./g, '').replace(',', '.');
  const value = parseFloat(normalized);
  return Number.isFinite(value) ? value : null;
}

/** "19.09.2026" -> "2026-09-19" ; иначе null */
function parseDate(raw) {
  const m = (raw || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/**
 * Дополняет ссылку именем сайта, если она относительная.
 *
 * ЛОВУШКА: портал отдаёт ссылки на карточку в двух видах. В выдаче по поиску
 * это полный адрес, а в выдаче по завершённым закупкам — путь от корня вида
 * /epz/order/notice/zk20/view/common-info.html. Запрос по такому пути падает
 * с «hostname could not be parsed» — то есть не тихо, но уже на живом портале.
 */
function absolute(url) {
  if (!url) return '';
  return url.startsWith('http') ? url : `https://zakupki.gov.ru${url}`;
}

/** Сколько карточек присутствует в разметке. Нужно, чтобы поймать молча пропущенные. */
function countCardBlocks(html) {
  return String(html).split('search-registry-entry-block').length - 1;
}

/**
 * Разбирает HTML страницы поиска в массив карточек закупок.
 * @param {string} html
 * @returns {Array<object>}
 */
function parseSearchPage(html) {
  const chunks = String(html).split('search-registry-entry-block').slice(1);
  const tenders = [];

  for (const chunk of chunks) {
    // Ссылку и номер берём из одного якоря в шапке карточки — это авторитетный
    // источник. Номер различается по длине (44-ФЗ — 19 цифр, 223-ФЗ — 11), а путь
    // к карточке у разных законов разный, поэтому URL не конструируем, а читаем.
    const header = chunk.match(/registry-entry__header-mid__number[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>\s*№\s*(\d+)/);
    const number = header ? header[2] : grab(chunk, /№\s*(\d{11}|\d{19})\b/);
    const noticeUrl = header ? absolute(decode(header[1])) : '';
    if (!number) continue;

    // Структурный разбор пар "заголовок -> значение".
    // По сырому тексту меток искать нельзя: в разметке встречаются
    // переносы строк и неразрывные пробелы внутри подписей.
    let object = '', customer = '', placingOrg = '';
    for (const block of chunk.split('registry-entry__body-block').slice(1)) {
      const title = textOf(block, 'registry-entry__body-title');
      if (!title) continue;
      const value = textOf(block, 'registry-entry__body-value') || textOf(block, 'registry-entry__body-href');

      if (/Объект закупки/i.test(title)) object = value;
      else if (/^Заказчик/i.test(title)) customer = value;
      else if (/Организация.*осуществляющая.*размещ/i.test(title)) placingOrg = value;
    }

    const priceRaw = textOf(chunk, 'price-block__value');
    const dates = collectPairs(chunk, 'data-block__title', 'data-block__value');
    const dateBy = (re) => {
      for (const [label, value] of dates) if (re.test(label)) return value;
      return '';
    };
    const publishedRaw = dateBy(/^Размещено/i);
    const updatedRaw = dateBy(/^Обновлено/i);
    const deadlineRaw = dateBy(/Окончание подачи/i);
    // У 44-ФЗ ссылка вида documents.html?regNumber=..., у 223-ФЗ —
    // documents.html?purchaseNoticeNumber=...&noticeGuid=... Берём любую.
    const docsPath = grab(chunk, /href="([^"]*documents\.html\?[^"]+)"/);
    // ИКЗ — идентификационный код закупки, 36 цифр; в нём зашита группа ОКПД2
    // (src/okpd.js). Портал печатает его в ссылке «Позиция плана-графика».
    // Есть только у 44-ФЗ.
    const ikz = grab(chunk, /openPlanGraphSearchUrl\('(\d{36})'\)/) || '';
    // У 223-ФЗ ИКЗ нет, но ссылка на заказчика несёт его ИНН и КПП -
    // по ним регион заказчика (src/region.js).
    const орг = chunk.match(/organization\/view223\/info\.html\?[^"]*?inn=(\d{10,12})(?:&amp;|&)kpp=(\d{9})/);

    tenders.push({
      number,
      law: textOf(chunk, 'registry-entry__header-top__title'),
      status: textOf(chunk, 'registry-entry__header-mid__title'),
      object,
      // ВАЖНО: заказчик и уполномоченный орган — разные юрлица.
      // При централизованных закупках орган публикует закупку за заказчика.
      // Отождествление приведёт к анализу контрагента не по тому лицу.
      customer,
      placingOrg,
      orgRole: customer ? 'заказчик' : (placingOrg ? 'уполномоченный орган' : null),
      orgName: customer || placingOrg || '',
      price: parseMoney(priceRaw),
      priceRaw: decode(priceRaw),
      published: parseDate(publishedRaw),
      deadline: parseDate(deadlineRaw),
      updated: parseDate(updatedRaw),
      url: noticeUrl,
      ikz,
      okpdGroup: группаИзИкз(ikz).группа,
      region: регионЗаказчика({ ikz, inn: орг ? орг[1] : '', kpp: орг ? орг[2] : '' }),
      // Сущности разворачиваются: «&amp;» в адресе портал не поймёт.
      docsUrl: absolute(decode(docsPath || '')),
      // Запасной адрес документов, полученный ЗАМЕНОЙ последнего сегмента в
      // ссылке на карточку. Не конструирование пути с нуля: тип процедуры
      // берётся из разметки, меняется только имя страницы.
      docsUrlAlt: noticeUrl && /common-info\.html/.test(noticeUrl)
        ? noticeUrl.replace('common-info.html', 'documents.html')
        : ''
    });
  }

  return tenders;
}

/**
 * Адреса страницы документации в том порядке, в котором их надо пробовать.
 *
 * ПОЧЕМУ НЕ ОДИН АДРЕС.
 * Проверено на портале 26.09.2026: у 44-ФЗ ссылка на документы, которую даёт
 * сама разметка, возвращает 404. Портал кладёт в карточку путь с сегментом
 * eap20 (zkp20, okp20), а рабочая страница лежит в том же сегменте, что и
 * карточка, — ea20 (zk20, ok20). У 223-ФЗ наоборот: ссылка из разметки
 * работает, а карточка лежит по совсем другому пути, из которого адрес
 * документов не вывести.
 *
 * Поэтому для 44-ФЗ первым идёт адрес, выведенный из ссылки на карточку, а
 * для 223-ФЗ — адрес из разметки. Второй кандидат остаётся как запасной:
 * если портал поменяет поведение, переход не сломается молча. Оба не ответили
 * — это не «документов нет», а повод для алерта.
 *
 * Основание — одна закупка и две попытки. Как только наберётся статистика по
 * разным процедурам, порядок пересмотреть.
 *
 * @param {object} t карточка из parseSearchPage
 * @returns {Array<string>} адреса без повторов, в порядке проверки
 */
function documentsUrls(t) {
  const is44 = String(t.number || '').length === 19;
  const ordered = is44 ? [t.docsUrlAlt, t.docsUrl] : [t.docsUrl, t.docsUrlAlt];
  return [...new Set(ordered.filter(Boolean))];
}

/**
 * Проверки на правдоподобность. Возвращает список проблем.
 * Пустой список — значение можно использовать без ручной проверки.
 * @param {object} t карточка из parseSearchPage
 * @param {Date} now точка отсчёта (для тестов передаётся фиксированная)
 */
function validateTender(t, now = new Date()) {
  const issues = [];

  // 44-ФЗ — 19 цифр, 223-ФЗ — 11.
  if (!/^(\d{11}|\d{19})$/.test(t.number || '')) issues.push('нераспознанный формат реестрового номера');
  if (!t.url) issues.push('нет ссылки на карточку закупки');
  if (!t.object) issues.push('пустой объект закупки');
  if (!t.orgName) issues.push('не определена организация');
  if (!t.orgRole) issues.push('не определена роль организации');

  if (t.price === null) issues.push('НМЦК не распознана');
  else if (t.price <= 0) issues.push('НМЦК меньше или равна нулю');

  if (!t.published) issues.push('не распознана дата размещения');
  if (!t.deadline) issues.push('не распознан срок подачи');

  if (t.published && t.deadline && t.deadline < t.published) {
    issues.push('срок подачи раньше даты размещения');
  }
  if (t.deadline) {
    const today = now.toISOString().slice(0, 10);
    // Просроченный тендер — не ошибка разбора, но участвовать в нём нельзя.
    if (t.deadline < today) issues.push('срок подачи уже прошёл');
  }
  if (!t.docsUrl) issues.push('нет ссылки на документацию');

  return issues;
}

module.exports = {
  parseSearchPage, validateTender, countCardBlocks, documentsUrls,
  parseMoney, parseDate, decode, tagEnd
};
