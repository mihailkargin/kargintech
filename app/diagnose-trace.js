/**
 * Диагностика разбора по сохранённому следу расчёта — без портала и без денег.
 *
 *   docker compose exec -T app node app/diagnose-trace.js --number 32616468091
 *
 * Печатает: из какого файла взяты позиции, первые позиции с количеством и
 * ценами, сумму позиций против НМЦК и строки документа вокруг таблицы
 * с видимыми табуляциями. Нужна, когда расчёт вышел неправдоподобным:
 * по ней видно, какая колонка принята за количество или цену.
 *
 * Работает и для 223-ФЗ: в отличие от diagnose-nmck.js адрес закупки
 * не строится, всё берётся из следа /data/state/verify-<номер>.json.
 */

const fs = require('fs');
const path = require('path');
const { строкаВерсии } = require('./fingerprint');

const SRC = path.join(__dirname, '..', 'src');
const { parseNmckTable } = require(path.join(SRC, 'nmck-table'));

function ключ(имя, поУмолчанию = '') {
  const i = process.argv.indexOf('--' + имя);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : поУмолчанию;
}

const видимо = (с) => String(с).replace(/\t/g, ' «TAB» ');
const коротко = (с, n = 60) => (String(с).length > n ? String(с).slice(0, n - 1) + '…' : String(с));

function main() {
  console.log(строкаВерсии());
  const номер = ключ('number');
  const строк = Number(ключ('rows', '30')) || 30;
  if (!номер) {
    console.log('Нужен номер закупки: --number 32616468091');
    process.exit(1);
  }
  const файл = path.join(process.env.STATE_DIR || '/data/state', `verify-${номер}.json`);
  if (!fs.existsSync(файл)) {
    console.log(`следа нет: ${файл}. Он появляется после расчёта этой закупки.`);
    process.exit(1);
  }
  const след = JSON.parse(fs.readFileSync(файл, 'utf8'));
  console.log(`закупка ${номер}, расчёт ${след.когда}`);
  console.log(`позиции взяты из: ${след.источник ? след.источник.имя : '— (не из таблицы)'}`);

  const позиции = след.позиции || [];
  console.log(`позиций ${позиции.length}`);
  let мин = 0;
  let макс = 0;
  for (const p of позиции) {
    if (typeof p.quantity === 'number' && typeof p.min === 'number') {
      мин += p.quantity * p.min;
      макс += p.quantity * (typeof p.max === 'number' ? p.max : p.min);
    }
  }
  console.log(`сумма «количество × цена»: ${Math.round(мин)} – ${Math.round(макс)} ₽`);
  console.log('\nПЕРВЫЕ ПОЗИЦИИ (наименование | кол-во | ед. | цены):');
  for (const p of позиции.slice(0, 12)) {
    const цены = (p.prices || []).map((x) => (x && typeof x === 'object'
      ? (x.value !== undefined ? x.value : x.price !== undefined ? x.price : JSON.stringify(x)) : x));
    console.log(`  ${коротко(p.name)} | ${p.quantity} | ${p.unit || ''} | ${цены.join(' / ')}`);
  }

  const текст = след.источник && след.источник.текст;
  if (!текст) return;
  const разбор = parseNmckTable(текст);
  console.log(`\nразбор: ${разбор.перевёрнутая ? 'перевёрнутая таблица' : 'обычная таблица'}`
    + (разбор.header ? `, шапка: ${видимо(JSON.stringify(разбор.header))}` : ''));
  if ((разбор.issues || []).length) console.log('замечания разбора: ' + разбор.issues.slice(0, 5).join('; '));

  const строки = String(текст).split('\n');
  const от = Math.max(0, строки.findIndex((с) => /наименован/i.test(с)) - 2);
  console.log(`\nСТРОКИ ДОКУМЕНТА с ${от + 1}-й (табуляция = «TAB»):`);
  for (const с of строки.slice(от, от + строк)) console.log('  ' + коротко(видимо(с), 220));
}

main();
