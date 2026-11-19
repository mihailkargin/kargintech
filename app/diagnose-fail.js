/**
 * Тексты документов неудачного разбора — без обращений к порталу.
 *
 *   docker compose exec -T app node app/diagnose-fail.js --number 32616483363
 *   … --file 0 --from 300 --rows 60     строки файла с 300-й, табуляции видны
 *   … --find "Количество"               строки со словом во всех файлах
 *
 * Тексты пишет расчёт при неудаче (app/estimate-run.js, сохранитьНеудачу).
 */
const fs = require('fs');
const path = require('path');

function ключ(имя, поУмолчанию = '') {
  const i = process.argv.indexOf('--' + имя);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : поУмолчанию;
}

const номер = ключ('number');
if (!номер) { console.log('Нужен номер: --number <номер закупки>'); process.exit(1); }
const файл = path.join(process.env.STATE_DIR || '/data/state', `fail-${номер.replace(/[^0-9A-Za-z-]/g, '_')}.json`);
let д;
try { д = JSON.parse(fs.readFileSync(файл, 'utf8')); } catch (e) {
  console.log(`нет ${файл}: тексты пишутся при неудачном разборе после 19.10.2026`);
  process.exit(1);
}
const вид = (s) => s.replace(/\t/g, ' «TAB» ');
console.log(`закупка ${д.номер}, разбор ${д.когда}`);
д.файлы.forEach((ф, i) => console.log(`  [${i}] «${ф.имя}» (${ф.вид || '—'}${ф.распознано ? ', скан' : ''}): `
  + `${ф.текст.length} знаков, строк ${ф.текст.split('\n').length}`));

const найти = ключ('find');
if (найти) {
  const н = найти.toLowerCase();
  д.файлы.forEach((ф, i) => ф.текст.split('\n').forEach((с, k) => {
    if (с.toLowerCase().includes(н)) console.log(`[${i}:${k + 1}] ${вид(с).slice(0, 300)}`);
  }));
  process.exit(0);
}
const какой = ключ('file');
if (какой !== '') {
  const ф = д.файлы[Number(какой)];
  if (!ф) { console.log('нет такого файла'); process.exit(1); }
  const с = Number(ключ('from', '1')) || 1;
  const n = Number(ключ('rows', '60')) || 60;
  ф.текст.split('\n').slice(с - 1, с - 1 + n).forEach((стр, k) => console.log(`${с + k}: ${вид(стр).slice(0, 400)}`));
}
