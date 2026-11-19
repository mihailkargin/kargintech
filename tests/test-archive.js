/**
 * Архив закупок (app/archive.js) на временном файле и на сохранённой выдаче
 * портала. Запуск: node tests/test-archive.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const А = require('../app/archive');
const { parseSearchPage } = require('../src/parser');

let failures = 0;
const check = (ok, m) => { console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${m}`); if (!ok) failures++; };

const каталог = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-'));
const файл = path.join(каталог, 'archive.db');
const выдача = parseSearchPage(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'search-bumaga-2026-09-19.html'), 'utf8'));

console.log('\n=== Выдача ===');
check(А.записатьВыдачу(выдача, 'бумага', файл) === выдача.length && выдача.length > 0, `записаны все карточки выдачи (${выдача.length})`);
А.записатьВыдачу(выдача, 'канцтовары', файл);
const с = А.сводкаАрхива(файл);
check(с.ok && с.закупок === выдача.length, 'повторная выдача не дублирует закупки');
check(с.регионов > 0 && с.заказчиков > 0, `регионы (${с.регионов}) и заказчики (${с.заказчиков}) сохранены`);
const { DatabaseSync } = require('node:sqlite');
const б = new DatabaseSync(файл);
const строка = б.prepare('SELECT * FROM tenders WHERE number = ?').get(выдача[0].number);
check(/бумага/.test(строка.words) && /канцтовары/.test(строка.words), 'слова, по которым закупку находили, накапливаются');
check(строка.object === выдача[0].object && строка.nmck === выдача[0].price, 'объект и начальная цена сохранены');

console.log('\n=== Разбор и протоколы ===');
check(А.записатьРазбор('123', { когда: '2026-10-22', ок: true, позиций: 2, наименования: ['Бумага А4'], обеспечения: { заявка: { требуется: false } } }, файл), 'итог разбора записан');
check(А.записатьРазбор('123', { когда: '2026-10-23', ок: true, позиций: 3, наименования: ['Бумага А4', 'Скобы'] }, файл), 'повторный разбор обновляет запись');
check(б.prepare('SELECT positions FROM parsed WHERE number = ?').get('123').positions === 3, 'в архиве последний разбор');
check(А.записатьПротокол({ номер: '777', нмцк: 100000, ценаПобеды: 80000, снижение: 20, участников: 4 }, файл), 'протокол записан');
check(А.сводкаАрхива(файл).протоколов === 1 && А.сводкаАрхива(файл).разобрано === 1, 'сводка считает разборы и протоколы');

console.log('\n=== Адрес по номеру ===');
{
  const а = А.адресПоНомеру(выдача[0].number, файл);
  check(а && а.url === выдача[0].url, 'адрес карточки по номеру из архива выдачи');
  б.exec("CREATE TABLE IF NOT EXISTS stream (number TEXT PRIMARY KEY, updated TEXT, deadline TEXT, card TEXT, seen TEXT)");
  б.prepare('INSERT INTO stream VALUES (?,?,?,?,?)').run('32616501065', '', '', JSON.stringify({ url: 'https://zakupki.gov.ru/223/x?regNumber=32616501065', docsUrl: 'https://zakupki.gov.ru/223/d?noticeGuid=1' }), '');
  const п = А.адресПоНомеру('32616501065', файл);
  check(п && /noticeGuid/.test(п.docsUrl), 'нет в архиве - берётся из потока, с адресом документов 223-ФЗ');
  check(А.адресПоНомеру('99999999999', файл) === null && А.адресПоНомеру("1' OR '1'='1", файл) === null, 'неизвестный и негодный номер - null');
}

console.log('\n=== Данных клиента в архиве нет ===');
const исходник = fs.readFileSync(path.join(__dirname, '..', 'app', 'archive.js'), 'utf8');
check(!/прайс|price-list|настройкиКлиента|clients/.test(исходник.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'архив не читает прайсы и настройки клиентов');

б.close();
А.закрыть();
console.log(failures ? `\nСБОЕВ: ${failures}` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
process.exit(failures ? 1 : 0);
