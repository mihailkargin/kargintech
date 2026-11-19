/**
 * Прогон кода воркфлоу на сохранённых страницах портала, без n8n.
 *
 * Смысл: Code-ноды — это обычный JavaScript, и его можно выполнить здесь,
 * подменив окружение n8n. Так ошибки находятся до того, как владелец начнёт
 * искать их в панели, где видно только «Error in node».
 */
const fs = require('fs');
const path = require('path');

const PROJECT = process.argv[2];
const WF = path.join(PROJECT, 'n8n', 'воркфлоу-1-поиск-тендеров.json');
const SRC = path.join(PROJECT, 'src');

const wf = JSON.parse(fs.readFileSync(WF, 'utf8'));
const nodeByName = (n) => wf.nodes.find((x) => x.name === n);

// Пути модулей в образе отличаются от локальных — подменяем.
const localize = (code) => code.split('/opt/tender/').join(SRC.replace(/\\/g, '/') + '/');

// Дата прогона. Сохранённые страницы собраны в прошлом, и с сегодняшней
// датой все тендеры в них просрочены — приоритет у всех «пропустить»,
// а ветка с подробными сообщениями не проверяется вовсе. Поэтому дату
// можно задать вторым аргументом: node прогон-воркфлоу.js <папка> 2026-09-20
const FAKE_DATE = process.argv[3] ? new Date(process.argv[3] + 'T09:00:00Z') : null;

/** Date, у которого «сегодня» — заданный день. Всё остальное как обычно. */
function fixedDate() {
  if (!FAKE_DATE) return Date;
  return class extends Date {
    constructor(...args) {
      if (args.length === 0) super(FAKE_DATE.getTime());
      else super(...args);
    }
    static now() { return FAKE_DATE.getTime(); }
  };
}

function runCode(code, env) {
  const names = Object.keys(env);
  const fn = new Function(...names, 'require', 'console', 'Date', localize(code));
  return fn(...names.map((n) => env[n]), require, console, fixedDate());
}

// --- Нода 1: настройки --------------------------------------------------
const settingsItems = runCode(nodeByName('Настройки клиента').parameters.jsCode, {});
console.log('=== Настройки ===');
console.log('  запросов к порталу:', settingsItems.length);
for (const i of settingsItems) console.log('   ', i.json.url);

// --- Вместо HTTP-запросов берём сохранённые страницы --------------------
const fixtures = fs.readdirSync(path.join(PROJECT, 'fixtures'))
  .filter((f) => /^search-.*\.html$/.test(f))
  .slice(0, 2);
console.log('\n=== Вместо портала подставлены сохранённые страницы ===');
for (const f of fixtures) console.log('   ', f);

const httpItems = fixtures.map((f) => ({
  json: { data: fs.readFileSync(path.join(PROJECT, 'fixtures', f), 'utf8') }
}));

// --- Нода 2: разбор, отбор, расчёт --------------------------------------
const staticData = {};
const env = {
  $input: { all: () => httpItems },
  $: (name) => ({ first: () => settingsItems[0] }),
  $getWorkflowStaticData: () => staticData
};

console.log('\n=== Прогон логики ===');
const out = runCode(nodeByName('Разбор, отбор и расчёт').parameters.jsCode, env);

console.log('\n=== Результат ===');
console.log('  сообщений к отправке:', out.length);
for (const item of out.slice(0, 2)) {
  console.log('\n--- сообщение, чат ' + item.json.chatId + ' ---');
  console.log(item.json.text);
}
if (out.length > 2) console.log('\n  ... и ещё ' + (out.length - 2));

// --- Второй прогон: дедупликация ----------------------------------------
console.log('\n=== Повторный прогон на тех же данных ===');
const out2 = runCode(nodeByName('Разбор, отбор и расчёт').parameters.jsCode, env);
console.log('  сообщений к отправке:', out2.length,
  out2.length === 0 ? '— повторы не рассылаются, верно' : '— ВНИМАНИЕ: повторы ушли бы снова');
