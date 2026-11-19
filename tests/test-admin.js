/**
 * Тесты команд владельца (site/admin.js): удаление компании по запросу.
 * Запуск: node tests/test-admin.js. База - временный файл.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { открыть } = require('../site/db');

let failures = 0;
const check = (ok, message) => {
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${message}`);
  if (!ok) failures++;
};

const кат = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-'));
const файл = path.join(кат, 'site.db');
const db = открыть(файл);
const к = db.создатьКомпанию('site-aaaa1111', 'ООО Удаляемая');
const у = db.создатьПользователя('del@test.ru', 'scrypt$x$y', к);
const влК = db.создатьКомпанию('site-bbbb2222', 'Владелец');
const вл = db.создатьПользователя('owner@test.ru', 'scrypt$x$y', влК, 'owner');
db.сохранитьНастройки(к, { слова: ['бумага'] });
db.создатьРасчёт(к, '0301100049626001767');
db.создатьПлатёж('p1', к, 'pro', 25000);
db.привязатьЧат(у, к, '555');
db.вОчередьTg('555', 'привет');
db.журнал('вход', 'del@test.ru', к, у);
db.сырая.close();

const запуск = (...арг) => {
  try { return execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'site', 'admin.js'), ...арг], { env: { ...process.env, SITE_DB: файл }, encoding: 'utf8' }); } catch (e) { return String(e.stdout || '') + String(e.message); }
};

const показ = запуск('delete-company', 'site-aaaa1111');
const после1 = открыть(файл);
check(/--yes/.test(показ) && после1.пользовательПоПочте('del@test.ru'), 'без --yes только показ, ничего не удалено');
после1.сырая.close();
check(/владельца/.test(запуск('delete-company', 'site-bbbb2222', '--yes')), 'компанию владельца удалить нельзя');
const итог = запуск('delete-company', 'site-aaaa1111', '--yes');
const п = открыть(файл);
check(/Удалено/.test(итог) && !п.пользовательПоПочте('del@test.ru'), 'пользователь удалён');
const сколько = (sql, ...a) => п.сырая.prepare(sql).get(...a).n;
check(сколько('SELECT COUNT(*) AS n FROM calcs WHERE company_id = ?', к) === 0 && сколько('SELECT COUNT(*) AS n FROM settings WHERE company_id = ?', к) === 0, 'расчёты и настройки удалены');
check(сколько("SELECT COUNT(*) AS n FROM log WHERE detail LIKE '%del@test.ru%'") === 0, 'почта из журнала удалена');
check(сколько('SELECT COUNT(*) AS n FROM outbox WHERE chat_id = ?', '555') === 0 && !п.чатПользователя(у), 'Telegram и очередь удалены');
check(п.платёж('p1') && п.компания(к).name === '[удалена]', 'платёж остался, у компании нет названия');
check(п.пользовательПоПочте('owner@test.ru'), 'другие пользователи не тронуты');
check(/Такой компании нет/.test(запуск('delete-company', 'site-нет', '--yes')), 'неизвестная компания - отказ');
п.сырая.close();
fs.rmSync(кат, { recursive: true, force: true });

console.log('');
if (failures) { console.log(`ПРОВЕРОК НЕ ПРОШЛО: ${failures}`); process.exit(1); }
console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
