/**
 * АРХИВ ЗАКУПОК - 22.10.2026, решение владельца: «важно накапливать базу
 * данных тендеров, чтобы потом получилось иметь реально годную аналитику как
 * в агрегаторах».
 *
 * Одна база на сервере (/data/state/archive.db, встроенный SQLite), общая для
 * всех клиентов, бессрочно. В неё пишется ТОЛЬКО публичное:
 *  - всё, что отдал портал на поиск любого клиента (а не только прошедшее
 *    отбор): номер, закон и способ, объект, заказчик, регион, код товара,
 *    начальная цена, сроки, ссылки; каким словом найдено;
 *  - итог разбора документации: позиции, обеспечения, условия контракта;
 *  - протоколы прошлых закупок: цена победы, снижение, участники.
 * Прайсы, настройки и расчёты клиентов сюда не пишутся никогда - сам архив
 * не знает, чей поиск его пополнил.
 *
 * Архив - побочная запись: его сбой не должен ломать поиск и разбор, поэтому
 * каждая запись в try/catch с одной строкой в журнал контейнера.
 */
const path = require('path');

let база = null;
let сломан = false;

function открыть(файл) {
  if (база || сломан) return база;
  try {
    const { DatabaseSync } = require('node:sqlite');
    база = new DatabaseSync(файл || path.join(process.env.STATE_DIR || '/data/state', 'archive.db'));
    база.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tenders (
        number TEXT PRIMARY KEY, law TEXT, status TEXT, object TEXT, customer TEXT, region TEXT,
        okpd TEXT, ikz TEXT, nmck REAL, deadline TEXT, published TEXT, url TEXT, docs_url TEXT,
        first_seen TEXT, last_seen TEXT, words TEXT
      );
      CREATE INDEX IF NOT EXISTS tenders_region ON tenders(region);
      CREATE INDEX IF NOT EXISTS tenders_okpd ON tenders(okpd);
      CREATE INDEX IF NOT EXISTS tenders_customer ON tenders(customer);
      CREATE TABLE IF NOT EXISTS parsed (number TEXT PRIMARY KEY, at TEXT, ok INTEGER, positions INTEGER, data TEXT);
      CREATE TABLE IF NOT EXISTS protocols (number TEXT PRIMARY KEY, at TEXT, nmck REAL, win_price REAL, discount REAL, participants INTEGER, data TEXT);
    `);
  } catch (e) {
    сломан = true;
    console.log(`архив закупок недоступен: ${e.message}`);
  }
  return база;
}

const сейчас = () => new Date().toISOString();
const т = (v) => (v === undefined || v === null ? null : String(v));
const ч = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

/** Карточки выдачи поиска (src/parser.js) - все, не только прошедшие отбор. */
function записатьВыдачу(карточки, слово = '', файл) {
  const б = открыть(файл);
  if (!б) return 0;
  try {
    const ins = б.prepare(`INSERT INTO tenders (number, law, status, object, customer, region, okpd, ikz, nmck, deadline, published, url, docs_url, first_seen, last_seen, words)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(number) DO UPDATE SET status=excluded.status, object=COALESCE(excluded.object, object), nmck=COALESCE(excluded.nmck, nmck),
        deadline=COALESCE(excluded.deadline, deadline), region=COALESCE(excluded.region, region), okpd=COALESCE(excluded.okpd, okpd),
        docs_url=COALESCE(excluded.docs_url, docs_url), last_seen=excluded.last_seen,
        words=CASE WHEN instr(COALESCE(words,''), excluded.words) > 0 THEN words ELSE substr(COALESCE(words || '; ', '') || excluded.words, 1, 1000) END`);
    const к = сейчас();
    let n = 0;
    б.exec('BEGIN');
    for (const x of карточки || []) {
      if (!x || !x.number) continue;
      ins.run(т(x.number), т(x.law), т(x.status), т(x.object) || null, т(x.orgName || x.customer), т(x.region), т(x.okpdGroup), т(x.ikz) || null,
        ч(x.price), т(x.deadline), т(x.published), т(x.url), т(x.docsUrl) || null, к, к, String(слово || '').slice(0, 100));
      n++;
    }
    б.exec('COMMIT');
    return n;
  } catch (e) {
    try { б.exec('ROLLBACK'); } catch (e2) { /* не было транзакции */ }
    console.log(`архив закупок: выдача не записана - ${e.message}`);
    return 0;
  }
}

/** Итог фонового разбора документации (app/parse-queue.js, итогРазбора). */
function записатьРазбор(номер, итог, файл) {
  const б = открыть(файл);
  if (!б || !номер || !итог) return false;
  try {
    const данные = {
      наименования: итог.наименования || [], обеспечения: итог.обеспечения || null, условия: итог.условия || null,
      группыОкпд2: итог.группыОкпд2 || [], ценаЗаЕдиницу: !!итог.ценаЗаЕдиницу, естьТЗ: !!итог.естьТЗ,
      отменена: !!итог.отменена, сбой: итог.ок ? null : (итог.сбой || null)
    };
    б.prepare('INSERT INTO parsed (number, at, ok, positions, data) VALUES (?,?,?,?,?) ON CONFLICT(number) DO UPDATE SET at=excluded.at, ok=excluded.ok, positions=excluded.positions, data=excluded.data')
      .run(String(номер), итог.когда || сейчас(), итог.ок ? 1 : 0, ч(итог.позиций) ?? 0, JSON.stringify(данные));
    return true;
  } catch (e) {
    console.log(`архив закупок: разбор ${номер} не записан - ${e.message}`);
    return false;
  }
}

/** Наблюдение из протокола прошлой закупки (app/collect-protocols.js). */
function записатьПротокол(н, файл) {
  const б = открыть(файл);
  if (!б || !н || !н.номер) return false;
  try {
    б.prepare('INSERT INTO protocols (number, at, nmck, win_price, discount, participants, data) VALUES (?,?,?,?,?,?,?) ON CONFLICT(number) DO UPDATE SET at=excluded.at, nmck=excluded.nmck, win_price=excluded.win_price, discount=excluded.discount, participants=excluded.participants, data=excluded.data')
      .run(String(н.номер), сейчас(), ч(н.нмцк), ч(н.ценаПобеды ?? н.цена), ч(н.снижение), ч(н.участников), JSON.stringify(н).slice(0, 20000));
    return true;
  } catch (e) {
    console.log(`архив закупок: протокол ${н.номер} не записан - ${e.message}`);
    return false;
  }
}

/** Сводка архива: сколько закупок, разборов, протоколов, по законам и регионам. */
function сводкаАрхива(файл) {
  const б = открыть(файл);
  if (!б) return { ok: false, сбой: 'архив недоступен' };
  const один = (sql) => б.prepare(sql).get();
  return {
    ok: true,
    закупок: один('SELECT COUNT(*) AS n FROM tenders').n,
    разобрано: один('SELECT COUNT(*) AS n FROM parsed WHERE ok = 1').n,
    протоколов: один('SELECT COUNT(*) AS n FROM protocols').n,
    регионов: один('SELECT COUNT(DISTINCT region) AS n FROM tenders WHERE region IS NOT NULL').n,
    заказчиков: один('SELECT COUNT(DISTINCT customer) AS n FROM tenders WHERE customer IS NOT NULL').n,
    первая: один('SELECT MIN(first_seen) AS d FROM tenders').d
  };
}

/** Для проверок: закрыть и забыть базу. */
/**
 * Адрес карточки и документов по номеру - из архива выдачи, затем из потока
 * (app/stream.js, та же база). Нужен расчёту по номеру закупки, которую клиенту
 * ещё не показывали: портал по номеру не ищет (03.10.2026).
 * @returns {{url: string, docsUrl: string}|null}
 */
function адресПоНомеру(номер, файл) {
  const б = открыть(файл);
  const н = String(номер || '').trim();
  if (!б || !/^\d{11,19}$/.test(н)) return null;
  try {
    const р = б.prepare('SELECT url, docs_url FROM tenders WHERE number = ?').get(н);
    if (р && р.url) return { url: р.url, docsUrl: р.docs_url || '' };
    const есть = б.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='stream'").get();
    const п = есть ? б.prepare('SELECT card FROM stream WHERE number = ?').get(н) : null;
    const к = п ? JSON.parse(п.card) : null;
    return к && к.url ? { url: к.url, docsUrl: к.docsUrl || '' } : null;
  } catch (e) {
    console.log(`архив закупок: адрес по номеру не прочитан - ${e.message}`);
    return null;
  }
}

function закрыть() { try { if (база) база.close(); } catch (e) { /* уже закрыта */ } база = null; сломан = false; }

module.exports = { записатьВыдачу, записатьРазбор, записатьПротокол, сводкаАрхива, адресПоНомеру, закрыть, открыть };
