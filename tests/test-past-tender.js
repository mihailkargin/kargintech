/**
 * Разбор прошлого тендера (app/past-tender.js) на подменённом расчёте и
 * протоколе - без портала. Случаи придуманы мной. Запуск: node tests/test-past-tender.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (ok, m) => { console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${m}`); if (!ok) failures++; };

const каталог = fs.mkdtempSync(path.join(os.tmpdir(), 'past-'));
fs.writeFileSync(path.join(каталог, 'site-abcdef123.json'), JSON.stringify({ economics: { taxRate: 0.06 } }));
process.env.CLIENTS_DIR = каталог;
const { разборПрошлого, адресКарточки } = require('../app/past-tender');

const смета = (ценыКлиента) => async () => ({
  ok: true,
  tender: { price: 100000, object: 'Бумага', url: 'x' },
  estimate: { rows: [{ name: 'Бумага', quantity: 200, priceForCalc: ценыКлиента ? 300 : 450, basis: ценыКлиента ? 'прайс клиента' : 'верхняя граница цены' }], total: ценыКлиента ? 60000 : 90000, totalMin: 0, totalMax: 0 },
  итоги: { закупкаИзвестна: true, закупка: ценыКлиента ? 60000 : 90000, безубыточность: 68000 },
  сводкаРазбора: { условия: { аванс: { есть: false }, пеня: { доля: '1/300 ключевой ставки ЦБ за каждый день просрочки' } } }
});
// Протокол: страница результатов и список заявок - подменённым запросом, без портала.
const fsr = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'phase3', 'supplier-results-0119600018526000086.html'), 'utf8');
const взять = async (u) => (/supplier-results/.test(u) ? { ok: true, тело: fsr } : { ok: false, код: 404 });

(async () => {
  check(/ea20\/view\/common-info\.html\?regNumber=0119600018526000086$/.test(адресКарточки('0119600018526000086')) && /\/223\//.test(адресКарточки('32616497177')), 'адрес карточки по номеру для 44-ФЗ и 223-ФЗ');
  check(!(await разборПрошлого('site-abcdef123', '123')).ok, 'неверный номер - отказ');
  const р = await разборПрошлого('site-abcdef123', '0119600018526000086', { собрать: смета(true), взять });
  check(р.ok && р.протокол.ценаПобеды > 0 && typeof р.протокол.снижение === 'number', `цена победы из протокола (${р.протокол && р.протокол.ценаПобеды}, падение ${р.протокол && р.протокол.снижение}%)`);
  check(typeof р.прибыль === 'number' && /заработали бы|убыточен/.test(р.вывод), `по ценам клиента - вывод о прибыли: ${р.вывод}`);
  check(р.условия && р.условия.аванс && р.условия.аванс.есть === false, 'условия контракта переданы');
  const б = await разборПрошлого('site-abcdef123', '0119600018526000086', { собрать: смета(false), взять });
  check(б.ok && б.прибыль === null && /вывод о прибыли не делается/.test(б.вывод), 'по ценам заказчика вывода о прибыли нет');
  const в = await разборПрошлого('site-abcdef123', '32616497177', { собрать: смета(true), взять });
  check(в.ok && !в.протокол.ценаПобеды && /223-ФЗ/.test(в.протокол.причина), '223-ФЗ - цены победы нет, причина названа');
  fs.rmSync(каталог, { recursive: true, force: true });
  console.log(failures ? `\nСБОЕВ: ${failures}` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  process.exit(failures ? 1 : 0);
})();
