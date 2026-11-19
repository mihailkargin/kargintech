/**
 * БАЗА САЙТА — встроенный в Node SQLite (node:sqlite), 21.10.2026.
 *
 * Почему не Postgres, который уже стоит на сервере: к нему нужен сторонний
 * драйвер, а в коде, работающем с данными клиента, сторонних библиотек в
 * проекте нет ни одной, и это аргумент в продаже. SQLite встроен в Node 22.
 *
 * Файл базы — в томе `site_data`, который попадает в резервную копию
 * (deploy/backup.sh). В нём почта и хеши паролей клиентов: это персональные
 * данные, и копия обязана их сохранить.
 *
 * ИЗОЛЯЦИЯ КЛИЕНТОВ. Каждая выборка данных клиента принимает company_id
 * явным аргументом и ставит его в WHERE. Функции «достать расчёт по номеру»
 * без компании нет вовсе — её нельзя вызвать по ошибке.
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const СХЕМА = `
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  calcs_used INTEGER NOT NULL DEFAULT 0,
  calcs_limit INTEGER NOT NULL DEFAULT 5,
  suppliers INTEGER NOT NULL DEFAULT 1,
  onboarded INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  role TEXT NOT NULL DEFAULT 'client',
  totp_secret TEXT,
  created TEXT NOT NULL,
  last_login TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  csrf TEXT NOT NULL,
  created TEXT NOT NULL,
  seen TEXT NOT NULL,
  totp_ok INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  used_by INTEGER,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  json TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tender_marks (
  company_id INTEGER NOT NULL REFERENCES companies(id),
  number TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  saved INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  updated TEXT NOT NULL,
  PRIMARY KEY (company_id, number)
);
CREATE TABLE IF NOT EXISTS calcs (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  number TEXT NOT NULL,
  status TEXT NOT NULL,
  created TEXT NOT NULL,
  finished TEXT,
  caption TEXT,
  totals TEXT,
  problems TEXT,
  error TEXT,
  file BLOB,
  file_name TEXT
);
CREATE TABLE IF NOT EXISTS searches (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  created TEXT NOT NULL,
  finished TEXT,
  summary TEXT
);
CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  company_id INTEGER,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS filter_sets (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS supplier_marks (
  company_id INTEGER NOT NULL REFERENCES companies(id),
  url TEXT NOT NULL,
  mark TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  updated TEXT NOT NULL,
  PRIMARY KEY (company_id, url)
);
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  tariff TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL,
  yk_id TEXT,
  pay_url TEXT,
  created TEXT NOT NULL,
  paid_at TEXT
);
CREATE TABLE IF NOT EXISTS best_plans (
  company_id INTEGER NOT NULL REFERENCES companies(id),
  day TEXT NOT NULL,
  queued INTEGER NOT NULL,
  created TEXT NOT NULL,
  PRIMARY KEY (company_id, day)
);
CREATE TABLE IF NOT EXISTS protocol_runs (
  word TEXT PRIMARY KEY,
  last TEXT NOT NULL,
  observations INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tg_codes (
  code_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS tg_chats (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  chat_id TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created TEXT NOT NULL,
  taken_at TEXT,
  sent_at TEXT,
  tries INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS calc_files (
  id INTEGER PRIMARY KEY,
  calc_id INTEGER NOT NULL REFERENCES calcs(id),
  name TEXT NOT NULL,
  data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS calc_files_calc ON calc_files(calc_id);
CREATE INDEX IF NOT EXISTS payments_company ON payments(company_id, created);
CREATE INDEX IF NOT EXISTS calcs_company ON calcs(company_id, id);
CREATE INDEX IF NOT EXISTS settings_company ON settings(company_id, id);
CREATE INDEX IF NOT EXISTS searches_company ON searches(company_id, id);
`;

const сейчас = () => new Date().toISOString();

function открыть(файл) {
  if (файл !== ':memory:') fs.mkdirSync(path.dirname(файл), { recursive: true });
  const d = new DatabaseSync(файл);
  d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  d.exec(СХЕМА);
  // Добавленные позже поля: у SQLite нет ADD COLUMN IF NOT EXISTS.
  for (const поле of ['calcs ADD COLUMN cost REAL', "calcs ADD COLUMN kind TEXT NOT NULL DEFAULT 'ручной'",
    "companies ADD COLUMN tariff TEXT NOT NULL DEFAULT ''", 'companies ADD COLUMN paid_until TEXT',
    'best_plans ADD COLUMN notified INTEGER NOT NULL DEFAULT 0', 'calcs ADD COLUMN kp TEXT', 'calcs ADD COLUMN upload TEXT']) {
    try { d.exec('ALTER TABLE ' + поле); } catch (e) { /* уже есть */ }
  }
  // Версия 1 (21.10.2026): пробный период 3 → 5 расчётов. Один раз и только
  // у тех, у кого стоял прежний предел 3 и нет тарифа: предел, выставленный
  // владельцем вручную на другое число, не трогается.
  if (d.prepare('PRAGMA user_version').get().user_version < 1) {
    d.exec("UPDATE companies SET calcs_limit = 5 WHERE calcs_limit = 3 AND tariff = ''");
    d.exec('PRAGMA user_version = 1');
  }
  // Версия 2: то же для компаний, созданных после версии 1 с прежним DEFAULT 3.
  if (d.prepare('PRAGMA user_version').get().user_version < 2) {
    d.exec("UPDATE companies SET calcs_limit = 5 WHERE calcs_limit = 3 AND tariff = ''");
    d.exec('PRAGMA user_version = 2');
  }
  return обёртка(d);
}

function обёртка(d) {
  const один = (sql, ...п) => d.prepare(sql).get(...п) || null;
  const все = (sql, ...п) => d.prepare(sql).all(...п);
  const выполнить = (sql, ...п) => d.prepare(sql).run(...п);

  return {
    сырая: d,
    журнал(действие, детали = '', компания = null, пользователь = null) {
      выполнить('INSERT INTO log(at, company_id, user_id, action, detail) VALUES (?,?,?,?,?)',
        сейчас(), компания, пользователь, действие, String(детали).slice(0, 2000));
    },

    // --- компании и пользователи ---------------------------------------
    создатьКомпанию(slug, имя) {
      // Предел пробного периода пишется явно: в базе, созданной до 21.10.2026,
      // у столбца остался прежний DEFAULT 3 (CREATE TABLE IF NOT EXISTS его не
      // меняет) - так тестер получил 3 расчёта вместо 5.
      const r = выполнить('INSERT INTO companies(slug, name, created, calcs_limit) VALUES (?,?,?,5)', slug, имя || '', сейчас());
      return Number(r.lastInsertRowid);
    },
    компания: (id) => один('SELECT * FROM companies WHERE id = ?', id),
    компании: () => все(`SELECT c.*, (SELECT ROUND(COALESCE(SUM(cost), 0), 4) FROM calcs WHERE company_id = c.id) AS cost_total,
      (SELECT ROUND(COALESCE(SUM(cost), 0), 4) FROM calcs WHERE company_id = c.id AND created >= date('now', 'start of month')) AS cost_month
      FROM companies c ORDER BY c.id DESC`),
    отметитьОнбординг: (id) => выполнить('UPDATE companies SET onboarded = 1 WHERE id = ?', id),
    задатьЛимит: (id, лимит) => выполнить('UPDATE companies SET calcs_limit = ? WHERE id = ?', лимит, id),
    создатьПользователя(почта, хеш, компания, роль = 'client') {
      const r = выполнить('INSERT INTO users(email, pass_hash, company_id, role, created) VALUES (?,?,?,?,?)',
        почта, хеш, компания, роль, сейчас());
      return Number(r.lastInsertRowid);
    },
    пользовательПоПочте: (почта) => один('SELECT * FROM users WHERE email = ?', почта),
    пользователь: (id) => один('SELECT * FROM users WHERE id = ?', id),
    пользователи: () => все('SELECT u.id, u.email, u.role, u.created, u.last_login, c.slug, c.name, c.id AS company_id FROM users u JOIN companies c ON c.id = u.company_id ORDER BY u.id DESC'),
    отметитьВход: (id) => выполнить('UPDATE users SET last_login = ? WHERE id = ?', сейчас(), id),
    задатьРоль: (id, роль) => выполнить('UPDATE users SET role = ? WHERE id = ?', роль, id),
    задатьTotp: (id, секрет) => выполнить('UPDATE users SET totp_secret = ? WHERE id = ?', секрет, id),
    задатьПароль: (id, хеш) => выполнить('UPDATE users SET pass_hash = ? WHERE id = ?', хеш, id),

    // --- сессии --------------------------------------------------------
    создатьСессию(ид, пользователь, csrf) {
      выполнить('INSERT INTO sessions(id, user_id, csrf, created, seen) VALUES (?,?,?,?,?)', ид, пользователь, csrf, сейчас(), сейчас());
    },
    сессия: (ид) => один('SELECT * FROM sessions WHERE id = ?', ид),
    продлитьСессию: (ид) => выполнить('UPDATE sessions SET seen = ? WHERE id = ?', сейчас(), ид),
    подтвердитьTotp: (ид) => выполнить('UPDATE sessions SET totp_ok = 1 WHERE id = ?', ид),
    удалитьСессию: (ид) => выполнить('DELETE FROM sessions WHERE id = ?', ид),
    удалитьСессииПользователя: (п) => выполнить('DELETE FROM sessions WHERE user_id = ?', п),
    чиститьСессии: (до) => выполнить('DELETE FROM sessions WHERE seen < ?', до),

    // --- сброс пароля (одноразовые ссылки) ----------------------------
    // В базе только хеш ссылки: утечка базы не даёт рабочих ссылок.
    создатьСброс: (хеш, пользователь, до) => выполнить('INSERT INTO password_resets(token_hash, user_id, expires) VALUES (?,?,?)', хеш, пользователь, до),
    сброс: (хеш) => один('SELECT * FROM password_resets WHERE token_hash = ?', хеш),
    использоватьСброс: (хеш) => выполнить('UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL', сейчас(), хеш),

    // --- приглашения ---------------------------------------------------
    создатьПриглашение: (код, заметка = '') => выполнить('INSERT INTO invites(code, created, note) VALUES (?,?,?)', код, сейчас(), заметка),
    приглашение: (код) => один('SELECT * FROM invites WHERE code = ?', код),
    использоватьПриглашение: (код, пользователь) => выполнить('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL', пользователь, сейчас(), код),
    приглашения: () => все('SELECT * FROM invites ORDER BY created DESC LIMIT 100'),

    // --- настройки (версиями) ------------------------------------------
    сохранитьНастройки: (компания, объект) => выполнить('INSERT INTO settings(company_id, json, created) VALUES (?,?,?)', компания, JSON.stringify(объект), сейчас()),
    настройки(компания) {
      const r = один('SELECT json FROM settings WHERE company_id = ? ORDER BY id DESC LIMIT 1', компания);
      return r ? JSON.parse(r.json) : null;
    },

    // --- отметки тендеров ----------------------------------------------
    отметки(компания) {
      const out = {};
      for (const r of все('SELECT * FROM tender_marks WHERE company_id = ?', компания)) out[r.number] = r;
      return out;
    },
    отметка: (компания, номер) => один('SELECT * FROM tender_marks WHERE company_id = ? AND number = ?', компания, номер),
    отметить(компания, номер, поля) {
      const было = this.отметка(компания, номер) || { decision: '', note: '', saved: 0, hidden: 0 };
      const н = { ...было, ...поля };
      выполнить(`INSERT INTO tender_marks(company_id, number, decision, note, saved, hidden, updated) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(company_id, number) DO UPDATE SET decision=excluded.decision, note=excluded.note, saved=excluded.saved, hidden=excluded.hidden, updated=excluded.updated`,
      компания, номер, String(н.decision || ''), String(н.note || '').slice(0, 2000), н.saved ? 1 : 0, н.hidden ? 1 : 0, сейчас());
    },

    // --- пометки о поставщиках (по компании) --------------------------
    пометкиПоставщиков(компания) {
      const out = {};
      for (const r of все('SELECT url, mark, note FROM supplier_marks WHERE company_id = ?', компания)) out[r.url] = r;
      return out;
    },
    пометитьПоставщика(компания, url, пометка, заметка) {
      выполнить(`INSERT INTO supplier_marks(company_id, url, mark, note, updated) VALUES (?,?,?,?,?)
        ON CONFLICT(company_id, url) DO UPDATE SET mark=excluded.mark, note=excluded.note, updated=excluded.updated`,
      компания, String(url).slice(0, 500), String(пометка || ''), String(заметка || '').slice(0, 1000), сейчас());
    },
    /** Последний расчёт по каждой закупке компании - для меток в ленте. */
    последниеРасчёты(компания) {
      const out = {};
      for (const r of все(`SELECT number, id, status, totals FROM calcs WHERE company_id = ? AND id IN
        (SELECT MAX(id) FROM calcs WHERE company_id = ? GROUP BY number)`, компания, компания)) out[r.number] = r;
      return out;
    },
    номераРасчётов: (компания) => все("SELECT DISTINCT number FROM calcs WHERE company_id = ? AND status = 'готов'", компания).map((r) => r.number),

    // --- сохранённые наборы фильтров ----------------------------------
    наборы: (компания) => все('SELECT id, name, query FROM filter_sets WHERE company_id = ? ORDER BY id', компания),
    сохранитьНабор(компания, имя, запрос) {
      const есть = один('SELECT COUNT(*) AS n FROM filter_sets WHERE company_id = ?', компания);
      if (есть && есть.n >= 20) return false;
      выполнить('INSERT INTO filter_sets(company_id, name, query, created) VALUES (?,?,?,?)', компания, String(имя).slice(0, 60), String(запрос).slice(0, 1000), сейчас());
      return true;
    },
    удалитьНабор: (компания, id) => выполнить('DELETE FROM filter_sets WHERE company_id = ? AND id = ?', компания, id),

    // --- тариф и оплата -------------------------------------------------
    задатьТариф: (компания, тариф, до) => выполнить('UPDATE companies SET tariff = ?, paid_until = ? WHERE id = ?', тариф, до, компания),
    /** Расчёты по кнопке с начала месяца по Москве; сбои и авторасчёты не считаются. */
    расчётовЗаМесяц(компания, now = new Date()) {
      const мск = new Date(now.getTime() + 3 * 3600 * 1000);
      const начало = new Date(Date.UTC(мск.getUTCFullYear(), мск.getUTCMonth(), 1) - 3 * 3600 * 1000).toISOString();
      const r = один("SELECT COUNT(*) AS n FROM calcs WHERE company_id = ? AND created >= ? AND status != 'сбой' AND kind = 'ручной'", компания, начало);
      return r ? r.n : 0;
    },
    создатьПлатёж: (ид, компания, тариф, сумма) => выполнить("INSERT INTO payments(id, company_id, tariff, amount, status, created) VALUES (?,?,?,?,'создан',?)", ид, компания, тариф, сумма, сейчас()),

    привязатьПлатёж: (ид, юк, ссылка) => выполнить("UPDATE payments SET yk_id = ?, pay_url = ?, status = 'ждёт оплаты' WHERE id = ?", юк, ссылка, ид),
    платёж: (ид) => один('SELECT * FROM payments WHERE id = ?', ид),
    платёжКомпании: (компания, ид) => один('SELECT * FROM payments WHERE company_id = ? AND id = ?', компания, ид),
    платёжПоЮк: (юк) => один('SELECT * FROM payments WHERE yk_id = ?', юк),
    платежиКомпании: (компания) => все('SELECT * FROM payments WHERE company_id = ? ORDER BY created DESC LIMIT 50', компания),
    платежи: () => все('SELECT p.*, c.name, c.slug FROM payments p JOIN companies c ON c.id = p.company_id ORDER BY p.created DESC LIMIT 100'),
    отменитьПлатёж: (ид, статус) => выполнить("UPDATE payments SET status = ? WHERE id = ? AND status != 'оплачен'", статус, ид),
    /**
     * Оплата прошла: платёж отмечается и тариф продлевается ОДНИМ действием.
     * Повторное уведомление ничего не меняет - условие status != 'оплачен'.
     * Возвращает true, если тариф продлён именно сейчас.
     */
    применитьОплату(ид, новыйСрок) {
      d.exec('BEGIN IMMEDIATE');
      try {
        const п = один('SELECT * FROM payments WHERE id = ?', ид);
        if (!п || п.status === 'оплачен') { d.exec('COMMIT'); return false; }
        const к = один('SELECT * FROM companies WHERE id = ?', п.company_id);
        const до = новыйСрок(к.paid_until, к.tariff, п.tariff);
        выполнить("UPDATE payments SET status = 'оплачен', paid_at = ? WHERE id = ?", сейчас(), ид);
        выполнить('UPDATE companies SET tariff = ?, paid_until = ? WHERE id = ?', п.tariff, до, п.company_id);
        d.exec('COMMIT');
        return true;
      } catch (e) {
        d.exec('ROLLBACK');
        throw e;
      }
    },

    // --- расчёты -------------------------------------------------------
    создатьРасчёт(компания, номер, вид = 'ручной') {
      const r = выполнить("INSERT INTO calcs(company_id, number, status, created, kind) VALUES (?,?,'ждёт',?,?)", компания, номер, сейчас(), вид);
      if (вид === 'ручной') выполнить('UPDATE companies SET calcs_used = calcs_used + 1 WHERE id = ?', компания);
      return Number(r.lastInsertRowid);
    },
    /**
     * Расчёт по загруженным документам (31.10.2026): закупка не из ЕИС - номер
     * «D-<id>», данные закупки (предмет, НМЦК, срок, обеспечения) в `upload`,
     * файлы - в calc_files. Считается как обычный ручной расчёт (пробный предел).
     */
    создатьРасчётПоДокументам(компания, мета, файлы) {
      const id = this.создатьРасчёт(компания, 'D-новый');
      выполнить('UPDATE calcs SET number = ?, upload = ? WHERE id = ?', `D-${id}`, JSON.stringify(мета), id);
      for (const ф of файлы) выполнить('INSERT INTO calc_files(calc_id, name, data) VALUES (?,?,?)', id, ф.имя, ф.данные);
      return id;
    },
    документыРасчёта(id) {
      const р = один('SELECT upload FROM calcs WHERE id = ?', id);
      if (!р || !р.upload) return null;
      return { мета: JSON.parse(р.upload), файлы: все('SELECT name, data FROM calc_files WHERE calc_id = ? ORDER BY id', id).map((ф) => ({ имя: ф.name, данные: Buffer.from(ф.data) })) };
    },
    расчёт: (компания, id) => один('SELECT id, company_id, number, status, created, finished, caption, totals, problems, error, file_name, kp, upload FROM calcs WHERE company_id = ? AND id = ?', компания, id),
    файлРасчёта: (компания, id) => один('SELECT file, file_name FROM calcs WHERE company_id = ? AND id = ? AND file IS NOT NULL', компания, id),
    расчётыКомпании: (компания) => все('SELECT id, number, status, created, finished, totals, error, upload FROM calcs WHERE company_id = ? ORDER BY id DESC LIMIT 200', компания),
    расчётыПоТендеру: (компания, номер) => все('SELECT id, status, created, finished, totals FROM calcs WHERE company_id = ? AND number = ? ORDER BY id DESC', компания, номер),
    // Расчёты по кнопке - раньше авторасчётов: клиент ждёт на странице.
    следующийРасчёт: () => один("SELECT c.id, c.company_id, c.number, c.kind, co.slug, co.suppliers FROM calcs c JOIN companies co ON co.id = c.company_id WHERE c.status = 'ждёт' ORDER BY (c.kind = 'авто'), c.id LIMIT 1"),
    готовыеРасчёты: (компания, с) => все("SELECT id, number, totals, kind, finished FROM calcs WHERE company_id = ? AND status = 'готов' AND finished >= ? ORDER BY id DESC LIMIT 200", компания, с),
    // --- Telegram: привязка чата и очередь сообщений -------------------
    // Код привязки хранится хешем: утечка базы не даёт привязать чужой кабинет.
    создатьКодTg: (хеш, пользователь, до) => выполнить('INSERT INTO tg_codes(code_hash, user_id, expires) VALUES (?,?,?)', хеш, пользователь, до),
    использоватьКодTg(хеш) {
      const к = один('SELECT * FROM tg_codes WHERE code_hash = ?', хеш);
      if (!к || к.used_at || Date.parse(к.expires) < Date.now()) return null;
      const r = выполнить('UPDATE tg_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL', сейчас(), хеш);
      return Number(r.changes) === 1 ? к.user_id : null;
    },
    привязатьЧат(пользователь, компания, чат) {
      выполнить(`INSERT INTO tg_chats(user_id, company_id, chat_id, created) VALUES (?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET chat_id = excluded.chat_id, company_id = excluded.company_id, created = excluded.created`, пользователь, компания, String(чат), сейчас());
    },
    отвязатьЧат: (пользователь) => выполнить('DELETE FROM tg_chats WHERE user_id = ?', пользователь),
    чатПользователя: (пользователь) => один('SELECT * FROM tg_chats WHERE user_id = ?', пользователь),
    чатыКомпании: (компания) => все('SELECT chat_id FROM tg_chats WHERE company_id = ?', компания).map((r) => r.chat_id),
    вОчередьTg: (чат, текст) => выполнить('INSERT INTO outbox(chat_id, text, created) VALUES (?,?,?)', String(чат), String(текст).slice(0, 4000), сейчас()),
    /**
     * Взять неотправленные. Взятое помечается: если n8n не подтвердит
     * отправку за 10 минут, сообщение выдаётся снова (не больше 5 раз).
     */
    взятьИзОчереди(n = 20) {
      const до = new Date(Date.now() - 10 * 60000).toISOString();
      const список = все('SELECT id, chat_id, text FROM outbox WHERE sent_at IS NULL AND tries < 5 AND (taken_at IS NULL OR taken_at < ?) ORDER BY id LIMIT ?', до, n);
      for (const с of список) выполнить('UPDATE outbox SET taken_at = ?, tries = tries + 1 WHERE id = ?', сейчас(), с.id);
      return список;
    },
    отправлено: (ид) => выполнить('UPDATE outbox SET sent_at = ? WHERE id = ?', сейчас(), ид),

    // --- запросы КП (Макс) ----------------------------------------------
    поставитьКП: (ид) => выполнить("UPDATE calcs SET kp = 'ждёт' WHERE id = ? AND kp IS NULL", ид),
    следующийКП: () => один("SELECT c.id, c.number, c.company_id, co.slug FROM calcs c JOIN companies co ON co.id = c.company_id WHERE c.kp = 'ждёт' ORDER BY c.id LIMIT 1"),
    отметитьКП: (ид, итог) => выполнить('UPDATE calcs SET kp = ? WHERE id = ?', String(итог).slice(0, 200), ид),
    компанияПоИмени: (slug) => один('SELECT * FROM companies WHERE slug = ?', slug),

    сборы: () => Object.fromEntries(все('SELECT * FROM protocol_runs').map((r) => [r.word, r])),
    отметитьСбор: (слово, n) => выполнить(`INSERT INTO protocol_runs(word, last, observations) VALUES (?,?,?)
      ON CONFLICT(word) DO UPDATE SET last = excluded.last, observations = excluded.observations`, слово, сейчас(), n),
    /** true - если оповещение о плане этого дня отмечено именно сейчас (повтор не отправится). */
    отметитьОповещениеПлана: (компания, день) => Number(выполнить('UPDATE best_plans SET notified = 1 WHERE company_id = ? AND day = ? AND notified = 0', компания, день).changes) === 1,
    планСделан: (компания, день) => !!один('SELECT 1 AS x FROM best_plans WHERE company_id = ? AND day = ?', компания, день),
    отметитьПлан: (компания, день, n) => выполнить('INSERT OR IGNORE INTO best_plans(company_id, day, queued, created) VALUES (?,?,?,?)', компания, день, n, сейчас()),
    авторасчётыЗаДень: (компания, с) => все("SELECT id, number, status, totals FROM calcs WHERE company_id = ? AND kind = 'авто' AND created >= ? ORDER BY id", компания, с),
    расчитанныеНомера: (компания) => new Set(все("SELECT DISTINCT number FROM calcs WHERE company_id = ? AND status IN ('ждёт','идёт','готов')", компания).map((r) => r.number)),
    начатьРасчёт: (id) => выполнить("UPDATE calcs SET status = 'идёт' WHERE id = ?", id),
    завершитьРасчёт(id, итог) {
      выполнить('UPDATE calcs SET status = ?, finished = ?, caption = ?, totals = ?, problems = ?, error = ?, file = ?, file_name = ? WHERE id = ?',
        итог.ok ? 'готов' : 'сбой', сейчас(), итог.подпись || null, итог.итоги ? JSON.stringify(итог.итоги) : null,
        итог.проблемы ? JSON.stringify(итог.проблемы) : null, итог.сбой || null, итог.файл || null, итог.имяФайла || null, id);
      if (typeof итог.стоимость === 'number') выполнить('UPDATE calcs SET cost = ? WHERE id = ?', итог.стоимость, id);
      // Сбой по нашей вине пробную попытку не съедает.
      if (!итог.ok) {
        выполнить("UPDATE companies SET calcs_used = MAX(0, calcs_used - 1) WHERE id = (SELECT company_id FROM calcs WHERE id = ? AND kind = 'ручной')", id);
      }
    },
    вернутьОборванные: () => выполнить("UPDATE calcs SET status = 'ждёт' WHERE status = 'идёт'"),
    сбоиРасчётов: () => все("SELECT c.id, c.number, c.created, c.error, co.slug FROM calcs c JOIN companies co ON co.id = c.company_id WHERE c.status = 'сбой' ORDER BY c.id DESC LIMIT 50"),

    // --- поиски --------------------------------------------------------
    создатьПоиск(компания, вид) {
      const r = выполнить("INSERT INTO searches(company_id, kind, status, created) VALUES (?,?,'ждёт',?)", компания, вид, сейчас());
      return Number(r.lastInsertRowid);
    },
    поискиКомпании: (компания) => все('SELECT * FROM searches WHERE company_id = ? ORDER BY id DESC LIMIT 20', компания),
    последнийПоиск: (компания) => один('SELECT * FROM searches WHERE company_id = ? ORDER BY id DESC LIMIT 1', компания),
    следующийПоиск: () => один("SELECT s.id, s.company_id, co.slug FROM searches s JOIN companies co ON co.id = s.company_id WHERE s.status = 'ждёт' ORDER BY s.id LIMIT 1"),
    начатьПоиск: (id) => выполнить("UPDATE searches SET status = 'идёт' WHERE id = ?", id),
    завершитьПоиск: (id, ок, сводка) => выполнить('UPDATE searches SET status = ?, finished = ?, summary = ? WHERE id = ?', ок ? 'готов' : 'сбой', сейчас(), String(сводка || '').slice(0, 2000), id),
    вернутьОборванныеПоиски: () => выполнить("UPDATE searches SET status = 'ждёт' WHERE status = 'идёт'"),
    журналЗаписи: (n = 100) => все('SELECT * FROM log ORDER BY id DESC LIMIT ?', n)
  };
}

module.exports = { открыть };
