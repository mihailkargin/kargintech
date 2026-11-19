/**
 * Тесты: порядок источников поиска поставщиков (владелец 03.11.2026) -
 * сначала Claude, при отказе по счёту или ключу - Yandex Cloud. Без сети:
 * посредник и поиск Яндексом подменены заглушками.
 * Запуск: node tests/test-supplier-order.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ord-'));
delete process.env.SUPPLIER_SEARCH;

let failures = 0;
function check(ok, label) {
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${label}`);
  if (!ok) failures++;
}

// Заглушки до загрузки estimate-run: он берёт функции при подключении.
let ответClaude = null;
let вызововClaude = 0;
require.cache[require.resolve('../app/proxy')] = { exports: { взятьЧерезПосредника: async () => { вызововClaude++; return ответClaude; } } };
let искалЯндекс = [];
require.cache[require.resolve('../app/yandex-run')] = { exports: {
  настройкиЯндекса: (н) => ({ ключ: н.yandexKey || '', папка: н.yandexFolder || '' }),
  найтиПоставщиковЯндексом: async (позиции) => {
    искалЯндекс = позиции.map((п) => п.name);
    const м = new Map();
    for (const п of позиции) м.set(п.name, [{ name: 'Оптовик', url: 'https://opt.ru/x', price: 100, unit: 'шт' }]);
    return { поЗаказчикам: м, issues: [], расход: { поисков: позиции.length } };
  }
} };
const { найтиПоставщиков } = require('../app/estimate-run');

const позиции = [
  { name: 'Бумага офисная А4 80 г/м2 500 листов', quantity: 10, unit: 'пачка' },
  { name: 'Скрепки металлические 28 мм', quantity: 5, unit: 'упаковка' }
];
const отказ = { ok: false, код: 403, тело: Buffer.from(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'verification_required' } })) };
const оба = { anthropicKey: 'k', proxyUrl: 'http://p', yandexKey: 'y', yandexFolder: 'f', каталогДанных: process.env.STATE_DIR };

(async () => {
  console.log('=== Claude отказал - Яндекс ищет все оставшиеся позиции ===');
  ответClaude = отказ; вызововClaude = 0; искалЯндекс = [];
  let ж = [];
  let р = await найтиПоставщиков(позиции, оба, ж);
  check(вызововClaude === 1, `Claude спрошен один раз, после отказа не повторяется (${вызововClaude})`);
  check(искалЯндекс.length === 2, `Яндекс искал обе позиции (${искалЯндекс.length})`);
  check(р.поЗаказчикам.get(позиции[1].name)[0].price === 100, 'цены Яндекса в результате');
  check(!р.issues.some((i) => /не завершён/.test(i)), 'клиенту нет «поиск не завершён» - запасной сработал');
  check(ж.some((с) => /Claude отказал - 2 позиций ищет Yandex/.test(с)), 'в журнале названа причина перехода');

  console.log('=== Без Яндекса - прежнее поведение ===');
  ответClaude = отказ; искалЯндекс = [];
  р = await найтиПоставщиков(позиции, { ...оба, yandexKey: '' }, []);
  check(!искалЯндекс.length && р.issues.some((i) => /не завершён по техническим причинам/.test(i)), 'Яндекса нет - честное «не завершён»');

  console.log('=== Claude не настроен - сразу Яндекс ===');
  вызововClaude = 0;
  р = await найтиПоставщиков(позиции, { ...оба, anthropicKey: '' }, []);
  check(вызововClaude === 0 && искалЯндекс.length === 2, 'без ключа Claude модель не вызывается, ищет Яндекс');

  console.log('=== SUPPLIER_SEARCH=yandex - Яндекс основной ===');
  process.env.SUPPLIER_SEARCH = 'yandex'; вызововClaude = 0;
  р = await найтиПоставщиков(позиции, оба, []);
  check(вызововClaude === 0 && искалЯндекс.length === 2, 'Claude не спрошен');
  delete process.env.SUPPLIER_SEARCH;

  console.log('=== Claude ответил - Яндекс не нужен ===');
  ответClaude = { ok: true, код: 200, тело: Buffer.from(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ suppliers: [{ name: 'Завод', url: 'https://zavod.ru/p', price: 90, unit: 'пачка', evidence: 'Цена 90 руб. за пачку' }] }) }], usage: {} })) };
  искалЯндекс = [];
  р = await найтиПоставщиков(позиции, оба, []);
  check(!искалЯндекс.length, 'Яндекс не вызывался');
  check(р.поЗаказчикам.get(позиции[0].name).some((s) => s.price === 90), 'цены Claude в результате');

  fs.rmSync(process.env.STATE_DIR, { recursive: true, force: true });
  console.log(failures ? `\nСБОЕВ: ${failures}` : '\nВсе проверки прошли');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log(e.stack); process.exit(1); });
