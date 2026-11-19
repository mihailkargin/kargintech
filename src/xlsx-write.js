/**
 * Запись файлов Excel (.xlsx) — без единой сторонней библиотеки.
 *
 * ЗАЧЕМ ЭТО ВООБЩЕ. Решение владельца от 30.09.2026: расчёт уходит клиенту
 * файлом Excel, а не ссылкой на Google-таблицу. Две причины, и обе весомые:
 * в России тендерные специалисты работают в Excel, и данные клиента при этом
 * не попадают к третьей стороне. Читать .xlsx мы умели с самого начала
 * (src/extract-text.js), писать — нет. Без записи отдавать клиенту нечего,
 * и продукт ничем не отличается от поиска по сайту.
 *
 * ПОЧЕМУ ФОРМУЛЫ, А НЕ ГОТОВЫЕ ЧИСЛА. Смета с готовыми числами — это картинка,
 * которой нужно верить. Смета с формулами — это расчёт, в котором клиент
 * меняет свою закупочную цену и сразу видит новую маржу. Он лучше нас знает,
 * почём купит у своего завода. Наша работа — собрать структуру и источники,
 * а не угадать его себестоимость.
 *
 * УСТРОЙСТВО .xlsx. Это ZIP-архив с XML внутри. Пишем его вручную: сам ZIP,
 * обязательные служебные файлы, листы. Сжатие — встроенным zlib.
 *
 * ЛОВУШКИ, каждая из которых даёт файл, который Excel отказывается открыть:
 *   — порядок элементов в styles.xml и workbook.xml строгий, перестановка
 *     ломает файл целиком, а сообщение Excel при этом ничего не объясняет;
 *   — строки на листе должны идти по возрастанию номера, ячейки в строке —
 *     по возрастанию буквы;
 *   — формула пишется БЕЗ знака равенства: <f>B2*C2</f>, а не <f>=B2*C2</f>;
 *   — разделитель дробной части в XML всегда точка, независимо от локали;
 *   — NaN и Infinity в числовую ячейку писать нельзя, файл станет битым;
 *   — текст обязан быть экранирован, иначе одна кавычка в названии товара
 *     рушит весь документ.
 */
const zlib = require('zlib');

// ------------------------------------------------------------------ ZIP

/**
 * Таблица CRC32. ZIP хранит контрольную сумму каждого файла, и без неё
 * архив считается повреждённым. Считается один раз при загрузке модуля.
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Собирает ZIP-архив из списка файлов.
 *
 * Пишем и локальные заголовки, и центральный каталог с настоящими размерами —
 * без потоковой записи с дескрипторами после данных. Так проще и надёжнее:
 * архив читается любым разборщиком, включая наш собственный.
 *
 * @param {Array<{name: string, data: Buffer}>} files
 * @returns {Buffer}
 */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = f.data;
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);

    // Метод 8 — deflate. Флаг 0x800 говорит, что имя в UTF-8.
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // версия, нужная для распаковки
    local.writeUInt16LE(0x0800, 6);      // флаги
    local.writeUInt16LE(8, 8);           // способ сжатия
    local.writeUInt16LE(0, 10);          // время
    local.writeUInt16LE(0x2821, 12);     // дата (условная, 2020-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // длина дополнительного поля
    locals.push(local, nameBuf, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // чем создано
    central.writeUInt16LE(20, 6);        // чем распаковывать
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x2821, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(0, 38);        // внешние атрибуты
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + comp.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);

  return Buffer.concat([localPart, centralPart, end]);
}

// ------------------------------------------------------------------ XML

/**
 * Экранирование для XML.
 *
 * Обязательно для всего текста без исключений: названия товаров приходят
 * с портала, и в них встречаются и кавычки, и амперсанды. Один незакрытый
 * символ делает файл нечитаемым целиком, а не портит одну ячейку.
 */
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Управляющие символы XML не допускает вовсе. В текстах с портала они
    // встречаются после неудачной конвертации старых форматов.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

/** Номер колонки в букву: 1 -> A, 27 -> AA. */
function colLetter(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ------------------------------------------------------------------ Стили

/**
 * Именованные стили. Номера соответствуют порядку в cellXfs ниже —
 * менять местами нельзя, Excel обращается к ним по индексу.
 */
const STYLE = {
  ОБЫЧНЫЙ: 0,
  ЗАГОЛОВОК_ДОКУМЕНТА: 1,
  ШАПКА_ТАБЛИЦЫ: 2,
  ДЕНЬГИ: 3,
  ДЕНЬГИ_ИТОГ: 4,
  ПРОЦЕНТ: 5,
  ЧИСЛО: 6,
  ПОЯСНЕНИЕ: 7,
  ПРЕДУПРЕЖДЕНИЕ: 8,
  ЖИРНЫЙ: 9,
  ПЕРЕНОС: 10
};

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2">
<numFmt numFmtId="164" formatCode="#,##0.00&quot; ₽&quot;"/>
<numFmt numFmtId="165" formatCode="0.0&quot; %&quot;"/>
</numFmts>
<fonts count="6">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><i/><sz val="10"/><color rgb="FF808080"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FF9C0006"/><name val="Calibri"/></font>
<font><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFD9E1F2"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFEB9C"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFB0B0B0"/></left><right style="thin"><color rgb="FFB0B0B0"/></right><top style="thin"><color rgb="FFB0B0B0"/></top><bottom style="thin"><color rgb="FFB0B0B0"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="11">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="164" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
<xf numFmtId="0" fontId="4" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// ------------------------------------------------------------------ Лист

// ------------------------------------------------------- Вычисление формул
//
// ЗАЧЕМ. Формула без готового числа видна пустой везде, кроме настольного
// Excel: просмотр файла в Telegram, на телефоне, в превью почты формулы не
// считает. 20.10.2026 владелец открыл смету из Telegram и не увидел ни цены
// победы, ни суммы закупки, ни прибыли — «в файле даже этого нет».
//
// Число рядом с формулой берётся ВЫЧИСЛЕНИЕМ ЭТОЙ САМОЙ ФОРМУЛЫ, а не из
// расчёта в коде: два независимых подсчёта могли бы разойтись, и клиент увидел
// бы в просмотрщике одно, а в Excel другое. Незнакомая функция или ошибка
// разбора — число не пишется, остаётся пустая ячейка, как было до 20.10.

const ОШИБКА_НД = { ошибка: '#N/A' };
const ОШИБКА_ЗНАЧ = { ошибка: '#VALUE!' };
const ОШИБКА_ДЕЛ = { ошибка: '#DIV/0!' };
const этоОшибка = (x) => x && typeof x === 'object' && 'ошибка' in x;

/** Номер колонки по буквам: A → 1, AB → 28. */
function номерКолонки(буквы) {
  let n = 0;
  for (const ch of буквы) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** Разбор формулы в токены. Неизвестный символ — исключение. */
function токены(f) {
  const out = [];
  let i = 0;
  while (i < f.length) {
    const c = f[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') {
      let j = i + 1, s = '';
      while (j < f.length) {
        if (f[j] === '"' && f[j + 1] === '"') { s += '"'; j += 2; continue; }
        if (f[j] === '"') break;
        s += f[j++];
      }
      if (j >= f.length) throw new Error('незакрытая строка');
      out.push({ t: 'стр', v: s }); i = j + 1; continue;
    }
    const число = /^\d+(\.\d+)?([eE][-+]?\d+)?/.exec(f.slice(i));
    if (число) { out.push({ t: 'число', v: Number(число[0]) }); i += число[0].length; continue; }
    // Ссылка: необязательный лист («Позиции!» или «'Лист 1'!»), ячейка, диапазон.
    const ссылка = /^(?:'([^']+)'!|([A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_ .]*)!)?\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?(?![A-Za-z(])/.exec(f.slice(i));
    if (ссылка) {
      out.push({ t: 'ссылка', лист: ссылка[1] || ссылка[2] || null,
        к1: номерКолонки(ссылка[3]), с1: Number(ссылка[4]),
        к2: ссылка[5] ? номерКолонки(ссылка[5]) : null, с2: ссылка[6] ? Number(ссылка[6]) : null });
      i += ссылка[0].length; continue;
    }
    const имя = /^[A-Za-z][A-Za-z0-9.]*(?=\()/.exec(f.slice(i));
    if (имя) { out.push({ t: 'функция', v: имя[0].toUpperCase() }); i += имя[0].length; continue; }
    const оп = /^(<=|>=|<>|[-+*/^&=<>(),])/.exec(f.slice(i));
    if (оп) { out.push({ t: 'оп', v: оп[0] }); i += оп[0].length; continue; }
    throw new Error(`неизвестный символ «${c}»`);
  }
  return out;
}

/**
 * Вычисляет формулу. `ячейка(лист, кол, стр)` отдаёт значение ячейки:
 * число, строку, true/false, ошибку или undefined (пусто).
 */
function вычислить(f, листПоУмолчанию, ячейка) {
  const т = токены(String(f).replace(/^=/, ''));
  let p = 0;
  const смотреть = () => т[p];
  const взять = (ожидание) => {
    const x = т[p++];
    if (!x || (ожидание && x.v !== ожидание)) throw new Error(`ожидалось «${ожидание}»`);
    return x;
  };
  const числом = (x) => {
    if (этоОшибка(x)) return x;
    if (x === undefined || x === null) return 0;
    if (typeof x === 'boolean') return x ? 1 : 0;
    if (typeof x === 'number') return x;
    if (x === '') return ОШИБКА_ЗНАЧ;
    const n = Number(String(x).replace(',', '.'));
    return Number.isFinite(n) ? n : ОШИБКА_ЗНАЧ;
  };
  const арифм = (a, b, fn) => {
    const x = числом(a), y = числом(b);
    if (этоОшибка(x)) return x;
    if (этоОшибка(y)) return y;
    return fn(x, y);
  };
  const сравнить = (a, b, оп) => {
    if (этоОшибка(a)) return a;
    if (этоОшибка(b)) return b;
    const пусто = (x) => x === undefined || x === null;
    let x = пусто(a) ? (typeof b === 'string' ? '' : 0) : a;
    let y = пусто(b) ? (typeof a === 'string' ? '' : 0) : b;
    if (typeof x === 'string' && typeof y === 'string') { x = x.toLowerCase(); y = y.toLowerCase(); }
    else if (typeof x !== typeof y) {
      // Excel: текст «больше» любого числа; строка и число не равны.
      const ранг = (v) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);
      x = ранг(x); y = ранг(y);
    }
    switch (оп) {
      case '=': return x === y;
      case '<>': return x !== y;
      case '<': return x < y;
      case '>': return x > y;
      case '<=': return x <= y;
      default: return x >= y;
    }
  };
  const диапазон = (s) => {
    const лист = s.лист || листПоУмолчанию;
    if (s.к2 === null) return [ячейка(лист, s.к1, s.с1)];
    const out = [];
    for (let r = Math.min(s.с1, s.с2); r <= Math.max(s.с1, s.с2); r++) {
      for (let c = Math.min(s.к1, s.к2); c <= Math.max(s.к1, s.к2); c++) out.push(ячейка(лист, c, r));
    }
    return out;
  };

  // Порядок как в Excel: сравнение < & < + - < * / < ^ < унарный минус.
  function сравнение() {
    let a = склейка();
    while (смотреть() && смотреть().t === 'оп' && ['=', '<>', '<', '>', '<=', '>='].includes(смотреть().v)) {
      const оп = взять().v; const b = склейка(); a = сравнить(a, b, оп);
    }
    return a;
  }
  function склейка() {
    let a = сумма();
    while (смотреть() && смотреть().v === '&') {
      взять(); const b = сумма();
      if (этоОшибка(a)) continue;
      if (этоОшибка(b)) { a = b; continue; }
      a = `${a === undefined ? '' : a}${b === undefined ? '' : b}`;
    }
    return a;
  }
  function сумма() {
    let a = произведение();
    while (смотреть() && (смотреть().v === '+' || смотреть().v === '-') && смотреть().t === 'оп') {
      const оп = взять().v; const b = произведение();
      a = арифм(a, b, (x, y) => (оп === '+' ? x + y : x - y));
    }
    return a;
  }
  function произведение() {
    let a = степень();
    while (смотреть() && (смотреть().v === '*' || смотреть().v === '/') && смотреть().t === 'оп') {
      const оп = взять().v; const b = степень();
      a = арифм(a, b, (x, y) => (оп === '*' ? x * y : (y === 0 ? ОШИБКА_ДЕЛ : x / y)));
    }
    return a;
  }
  function степень() {
    let a = унарный();
    while (смотреть() && смотреть().v === '^') { взять(); const b = унарный(); a = арифм(a, b, (x, y) => x ** y); }
    return a;
  }
  function унарный() {
    if (смотреть() && смотреть().t === 'оп' && смотреть().v === '-') { взять(); return арифм(0, унарный(), (x, y) => x - y); }
    if (смотреть() && смотреть().t === 'оп' && смотреть().v === '+') { взять(); return унарный(); }
    return первичное();
  }
  function аргументы() {
    взять('(');
    const арг = [];
    if (смотреть() && смотреть().v === ')') { взять(); return арг; }
    for (;;) {
      арг.push(p); // запоминаем начало — IF вычисляет ветки лениво
      пропуститьВыражение();
      if (смотреть() && смотреть().v === ',') { взять(); continue; }
      взять(')');
      return арг;
    }
  }
  function пропуститьВыражение() {
    let глубина = 0;
    while (p < т.length) {
      const x = т[p];
      if (x.v === '(' && x.t === 'оп') глубина++;
      else if (x.v === ')' && x.t === 'оп') { if (глубина === 0) return; глубина--; }
      else if (x.v === ',' && x.t === 'оп' && глубина === 0) return;
      p++;
    }
  }
  function вычислитьАргумент(начало) {
    const сохр = p; p = начало;
    const v = сравнение();
    p = сохр;
    return v;
  }
  function значенияАргумента(начало) {
    const x = т[начало];
    const следующий = т[начало + 1];
    const конецАргумента = !следующий || (следующий.t === 'оп' && (следующий.v === ',' || следующий.v === ')'));
    if (x && x.t === 'ссылка' && x.к2 !== null && конецАргумента) return диапазон(x);
    return [вычислитьАргумент(начало)];
  }
  function первичное() {
    const x = взять();
    if (x.t === 'число' || x.t === 'стр') return x.v;
    if (x.t === 'ссылка') {
      if (x.к2 !== null) throw new Error('диапазон вне функции');
      return ячейка(x.лист || листПоУмолчанию, x.к1, x.с1);
    }
    if (x.t === 'оп' && x.v === '(') { const v = сравнение(); взять(')'); return v; }
    if (x.t === 'функция') {
      const имя = x.v;
      const арг = аргументы();
      switch (имя) {
        case 'IF': {
          const усл = вычислитьАргумент(арг[0]);
          if (этоОшибка(усл)) return усл;
          const истина = typeof усл === 'string' ? усл !== '' : Boolean(числом(усл));
          if (истина) return арг.length > 1 ? вычислитьАргумент(арг[1]) : true;
          return арг.length > 2 ? вычислитьАргумент(арг[2]) : false;
        }
        case 'OR': case 'AND': {
          const все = арг.flatMap(значенияАргумента);
          const ош = все.find(этоОшибка);
          if (ош) return ош;
          const логич = все.map((v) => (typeof v === 'string' ? v !== '' : Boolean(числом(v))));
          return имя === 'OR' ? логич.some(Boolean) : логич.every(Boolean);
        }
        case 'ISBLANK': {
          const s = т[арг[0]];
          if (!s || s.t !== 'ссылка') return false;
          const v = ячейка(s.лист || листПоУмолчанию, s.к1, s.с1);
          return v === undefined || v === null;
        }
        case 'NA': return ОШИБКА_НД;
        case 'SUM': case 'MIN': case 'MAX': {
          const все = арг.flatMap(значенияАргумента);
          const ош = все.find(этоОшибка);
          if (ош) return ош;
          const числа = все.filter((v) => typeof v === 'number');
          if (имя === 'SUM') return числа.reduce((s, v) => s + v, 0);
          if (!числа.length) return 0;
          return имя === 'MIN' ? Math.min(...числа) : Math.max(...числа);
        }
        case 'ROUND': {
          const v = числом(вычислитьАргумент(арг[0]));
          const n = арг.length > 1 ? числом(вычислитьАргумент(арг[1])) : 0;
          if (этоОшибка(v)) return v;
          if (этоОшибка(n)) return n;
          const k = 10 ** n;
          return Math.round(v * k) / k;
        }
        default: throw new Error(`функция ${имя} не поддерживается`);
      }
    }
    throw new Error('непонятное выражение');
  }

  const результат = сравнение();
  if (p !== т.length) throw new Error('лишние символы в формуле');
  return результат;
}

/**
 * Готовые значения всех формул книги: ключ «номер листа!A1» → значение.
 * Формула, которую вычислить не удалось, в карту не попадает.
 */
function вычислитьКнигу(sheets) {
  const поИмени = new Map(sheets.map((s, i) => [s.name, i]));
  const кэш = new Map();
  const считаются = new Set();
  const сырая = (i, c, r) => {
    const row = (sheets[i].rows || [])[r - 1];
    return row ? row[c - 1] : undefined;
  };
  const ячейка = (лист, c, r) => {
    const i = typeof лист === 'number' ? лист : поИмени.get(лист);
    if (i === undefined) throw new Error(`нет листа «${лист}»`);
    const ключ = `${i}!${c},${r}`;
    if (кэш.has(ключ)) return кэш.get(ключ);
    const x = сырая(i, c, r);
    const o = (x !== null && typeof x === 'object' && !(x instanceof Date)) ? x : { v: x };
    if (!o.f) return (o.v === '' || o.v === null) ? undefined : o.v;
    if (считаются.has(ключ)) throw new Error('циклическая ссылка');
    считаются.add(ключ);
    try {
      const v = вычислить(o.f, i, ячейка);
      кэш.set(ключ, v);
      return v;
    } finally { считаются.delete(ключ); }
  };
  const итог = new Map();
  sheets.forEach((s, i) => (s.rows || []).forEach((row, ri) => (row || []).forEach((x, ci) => {
    if (!x || typeof x !== 'object' || !x.f) return;
    try {
      const v = ячейка(i, ci + 1, ri + 1);
      if (typeof v === 'number' && !Number.isFinite(v)) return;
      итог.set(`${i}!${colLetter(ci + 1)}${ri + 1}`, v);
    } catch (e) { /* не вычислилась — число не пишем */ }
  })));
  return итог;
}

/** Готовое значение формулы в XML: число, строка, логическое или ошибка. */
function кэшXml(v) {
  if (v === undefined || v === null) return { t: '', xml: '' };
  if (этоОшибка(v)) return { t: ' t="e"', xml: `<v>${v.ошибка}</v>` };
  if (typeof v === 'boolean') return { t: ' t="b"', xml: `<v>${v ? 1 : 0}</v>` };
  if (typeof v === 'number') return { t: '', xml: `<v>${v}</v>` };
  return { t: ' t="str"', xml: `<v>${esc(безДлинныхТире(String(v)))}</v>` };
}

/**
 * Длинное «—» и среднее «–» тире — обычным дефисом во всём, что видит клиент.
 * Требование владельца 20.10.2026: «не используй длинное тире, используй
 * обычное маленькое». Заменяется на выходе (файл, ответ приложения), а не в
 * сотне строк кода: так ни одна строка не проскочит.
 */
function безДлинныхТире(текст) {
  return String(текст).replace(/[—–]/g, '-');
}

/**
 * Одна ячейка в XML.
 *
 * @param {string} ref адрес вида «B7»
 * @param {*} cell значение, либо {v, f, s}
 * @param {*} [готовое] вычисленное значение формулы (вычислитьКнигу)
 */
function cellXml(ref, cell, готовое) {
  if (cell === null || cell === undefined || cell === '') return '';

  const o = (typeof cell === 'object' && !(cell instanceof Date)) ? cell : { v: cell };
  const s = typeof o.s === 'number' ? ` s="${o.s}"` : '';

  // ПУСТОЕ ЗНАЧЕНИЕ — ПУСТАЯ ЯЧЕЙКА, А НЕ ПУСТОЙ ТЕКСТ.
  //
  // Найдено 03.10.2026 владельцем на готовой смете. Ячейка {v: null}
  // попадала в последнюю ветку и записывалась как текстовая с пустой
  // строкой внутри. Excel при сложении текста с числом даёт #ЗНАЧ!, и одна
  // незаполненная логистика рушила ВЕСЬ расчёт: прибыль, маржу и потребность
  // в деньгах разом. Выглядело это как поломка файла, а не как «нет данных».
  //
  // Стиль при этом сохраняем: заливка и рамка нужны, чтобы незаполненное
  // место было видно глазами.
  if (!o.f && (o.v === null || o.v === undefined || o.v === '')) {
    return s ? `<c r="${ref}"${s}/>` : '';
  }

  // Формула. Знак равенства не пишется — Excel добавит его сам.
  if (o.f) {
    const f = String(o.f).replace(/^=/, '');
    // Готовое значение — вычисление этой самой формулы (вычислитьКнигу), а не
    // число из расчёта в коде: иначе просмотрщик и Excel могли бы показать
    // разное. Не вычислилась — пишется одна формула, как было до 20.10.2026.
    const к = кэшXml(готовое);
    return `<c r="${ref}"${s}${к.t}><f>${esc(f)}</f>${к.xml}</c>`;
  }

  if (typeof o.v === 'number') {
    // NaN и Infinity сделали бы файл битым. Отсутствие числа — это пустая
    // ячейка, а не ноль: ноль означал бы «посчитано и получилось ноль».
    if (!Number.isFinite(o.v)) return '';
    return `<c r="${ref}"${s}><v>${o.v}</v></c>`;
  }

  if (typeof o.v === 'boolean') {
    return `<c r="${ref}"${s} t="b"><v>${o.v ? 1 : 0}</v></c>`;
  }

  // Текст пишем прямо в ячейку, без общей таблицы строк: файлы небольшие,
  // а одной обязательной частью меньше — меньше мест, где можно ошибиться.
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(безДлинныхТире(o.v))}</t></is></c>`;
}

function sheetXml(sheet, готовые = new Map(), номерЛиста = 0) {
  const cols = (sheet.columns || []).map((c, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${c.width || 12}" customWidth="1"/>`
  ).join('');

  const rows = (sheet.rows || []).map((row, ri) => {
    if (!row || row.length === 0) return '';
    const cells = row.map((cell, ci) => {
      const ref = colLetter(ci + 1) + (ri + 1);
      return cellXml(ref, cell, готовые.get(`${номерЛиста}!${ref}`));
    }).join('');
    if (!cells) return '';
    const h = sheet.rowHeights && sheet.rowHeights[ri] ? ` ht="${sheet.rowHeights[ri]}" customHeight="1"` : '';
    return `<row r="${ri + 1}"${h}>${cells}</row>`;
  }).join('');

  const merges = (sheet.merges || []).length
    ? `<mergeCells count="${sheet.merges.length}">`
      + sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')
      + '</mergeCells>'
    : '';

  // Закрепление шапки: клиент прокручивает длинную смету и не теряет названия
  // колонок. Мелочь, из-за которой таблицей начинают пользоваться.
  const freeze = sheet.freezeRow
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sheet.freezeRow}" topLeftCell="A${sheet.freezeRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}`
    + (cols ? `<cols>${cols}</cols>` : '')
    + `<sheetData>${rows}</sheetData>${merges}</worksheet>`;
}

// ------------------------------------------------------------------ Книга

/**
 * Собирает файл .xlsx.
 *
 * @param {Array<{name: string, columns?: Array, rows: Array, merges?: Array, freezeRow?: number}>} sheets
 * @returns {Buffer} содержимое файла
 */
function writeXlsx(sheets) {
  if (!Array.isArray(sheets) || sheets.length === 0) {
    throw new Error('нет ни одного листа — пустой файл Excel отдавать нельзя');
  }

  // Имя листа Excel ограничивает: не длиннее 31 знака и без : \ / ? * [ ]
  const safeName = (n, i) => {
    const clean = String(n || `Лист${i + 1}`).replace(/[:\\\/?*\[\]]/g, ' ').slice(0, 31).trim();
    return clean || `Лист${i + 1}`;
  };

  const files = [];

  files.push({
    name: '[Content_Types].xml',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`, 'utf8')
  });

  files.push({
    name: '_rels/.rels',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`, 'utf8')
  });

  files.push({
    name: 'xl/workbook.xml',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
${sheets.map((s, i) => `<sheet name="${esc(safeName(s.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('\n')}
</sheets>
<calcPr fullCalcOnLoad="1"/>
</workbook>`, 'utf8')
  });

  files.push({
    name: 'xl/_rels/workbook.xml.rels',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`, 'utf8')
  });

  files.push({ name: 'xl/styles.xml', data: Buffer.from(STYLES_XML, 'utf8') });

  // Готовые числа формул — для просмотрщиков, которые формулы не считают.
  // Excel всё равно пересчитает при открытии (fullCalcOnLoad выше).
  const готовые = вычислитьКнигу(sheets);
  sheets.forEach((s, i) => {
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(s, готовые, i), 'utf8') });
  });

  return makeZip(files);
}

module.exports = { writeXlsx, STYLE, colLetter, crc32, makeZip, esc, вычислить, вычислитьКнигу, безДлинныхТире };
