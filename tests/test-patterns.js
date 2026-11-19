/**
 * Проверка шаблонов на кириллическую ловушку.
 * Запуск: node tests/test-patterns.js
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ ПРОВЕРКА.
 * В JavaScript \w, \W, \b и \B считают буквами только латиницу, цифры и
 * подчёркивание. Поэтому шаблон с русским словом рядом с ними не совпадает
 * никогда или совпадает не там. Примеры (записаны без косых черт по краям,
 * иначе звёздочка со слешем закрыла бы этот комментарий):
 *
 *   \bИНН\s*\d+            — не найдёт ИНН ни разу
 *   паспорт\w*             — не доберёт окончание
 *   техническ\w*\s+задани  — не совпадёт со словом «техническое задание»
 *
 * Такой код не падает и не пишет ошибок. Он молча ничего не находит. В этом
 * проекте ловушка срабатывала трижды: в защите реквизитов, в разборе паспорта
 * и в определении назначения документа — в последнем случае это означало, что
 * бланк заявки уходит в модель за деньги, а техзадание с позициями лота нет.
 *
 * Правило: рядом с кириллицей вместо \w писать [а-яё] или [А-Яа-яЁё],
 * вместо \b — явные границы через (?<![А-Яа-яЁёA-Za-z0-9]).
 *
 * Если проверка ругается на осознанное исключение — добавь комментарий
 * // кириллица-ок в той же строке.
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (ok, message) => {
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${message}`);
  if (!ok) failures++;
};
const section = (name) => console.log(`\n=== ${name} ===`);

const SRC = path.join(__dirname, '..', 'src');
const CYRILLIC = /[А-Яа-яЁё]/;
const ESCAPES = /\\[wWbB]/;

/**
 * Вырезает из строки кода литералы регулярных выражений и содержимое
 * new RegExp('...'). Разбор нарочно грубый: цель — заметить подозрительное
 * место и заставить человека посмотреть, а не построить парсер JavaScript.
 */
function patternsIn(line) {
  const found = [];
  // Литералы /.../флаги — без деления и комментариев по краям.
  for (const m of line.matchAll(/(?:^|[=(,:[|&!?{]\s*)(\/(?![/*])(?:\\.|\[[^\]]*\]|[^/\\\n])+\/[gimsuyv]*)/g)) {
    found.push(m[1]);
  }
  // Строки внутри new RegExp(...) и склейки шаблонов.
  for (const m of line.matchAll(/(['"])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    if (/\\[wWbBdsS]/.test(m[2])) found.push(m[2]);
  }
  return found;
}

section('Шаблоны с кириллицей не используют \\w и \\b');

const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.js'));
check(files.length > 0, `файлов в src/: ${files.length}`);

const suspects = [];
for (const file of files) {
  const lines = fs.readFileSync(path.join(SRC, file), 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (/кириллица-ок/.test(line)) return;
    // Комментарии пропускаем: в них ловушка описана словами, и это не код.
    const code = line.replace(/\/\/.*$/, '');
    if (!CYRILLIC.test(code) || !ESCAPES.test(code)) return;

    for (const p of patternsIn(code)) {
      if (CYRILLIC.test(p) && ESCAPES.test(p)) {
        suspects.push({ file, line: i + 1, pattern: p.trim().slice(0, 100) });
      }
    }
  });
}

if (suspects.length) {
  console.log('  Подозрительные шаблоны:');
  suspects.forEach((s) => console.log(`    ${s.file}:${s.line}  ${s.pattern}`));
}
check(suspects.length === 0,
  suspects.length === 0
    ? 'в шаблонах с русскими словами нет \\w и \\b'
    : `найдено шаблонов с кириллицей рядом с \\w или \\b: ${suspects.length}`);

section('Сама проверка работает');
// Проверяем на заведомо плохих и заведомо хороших строках, иначе проверка
// может «проходить» просто потому, что ничего не ищет.
const bad = [
  'const X = /\\bИНН\\s*\\d+/gi;',
  "const Y = new RegExp('паспорт\\\\w*\\\\s+\\\\d{6}', 'i');",
  'if (/техническ\\w*\\s+задани/i.test(name)) return 1;'
];
const good = [
  'const X = /(?<![А-Яа-яЁё])ИНН\\s*\\d+/gi;',
  'const Y = /техническ[а-яё]*\\s+задани/i;',
  'const Z = /\\b\\d{11}\\b/g;',
  'const W = /[А-ЯЁ][а-яё]+/g;'
];
const flags = (line) => patternsIn(line.replace(/\/\/.*$/, ''))
  .some((p) => CYRILLIC.test(p) && ESCAPES.test(p));

bad.forEach((line, i) => check(flags(line), `плохой пример ${i + 1} распознан как опасный`));
good.forEach((line, i) => check(!flags(line), `хороший пример ${i + 1} не вызывает ложной тревоги`));

console.log(`\n${failures === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : 'ПРОВАЛЕНО ПРОВЕРОК: ' + failures}`);
process.exit(failures === 0 ? 0 : 1);
