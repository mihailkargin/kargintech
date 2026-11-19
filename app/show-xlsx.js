/**
 * Показывает, что увидит клиент в файле Excel расчёта, — без Telegram.
 *
 *   docker compose exec -T app node app/show-xlsx.js --number 0326100005026000005
 *
 * Считает закупку через /estimate с настройками клиента kargin, БЕЗ поиска
 * поставщиков (денег не тратит), и печатает лист «Расчёт» строками с готовыми
 * числами — так, как их показывает просмотрщик, не считающий формулы.
 */
const { extractText } = require('../src/extract-text');

const i = process.argv.indexOf('--number');
const номер = i !== -1 ? process.argv[i + 1] : '';
const к = process.argv.indexOf('--client');
const клиент = к !== -1 ? process.argv[к + 1] : 'kargin';
if (!номер) { console.log('Нужен номер: --number <номер закупки>'); process.exit(1); }

fetch('http://localhost:3100/estimate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ клиент, номер, настройки: {
    искатьПоставщиков: false,
    // --save-texts: тексты документов в /data/state/fail-<номер>.json
    ...(process.argv.includes('--save-texts') ? { сохранитьТексты: true } : {})
  } })
}).then((r) => r.json()).then((j) => {
  if (!j.ok) { console.log('расчёт не собрался:', j.сбой, j.подробно || ''); return; }
  const текст = extractText(Buffer.from(j.файл.base64, 'base64'), 'a.xlsx').text || '';
  console.log(текст.split('--- лист 3')[0]);
}).catch((e) => console.log('сбой:', e.message));
