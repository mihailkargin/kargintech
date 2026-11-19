// Проверка файла воркфлоу: разбирается ли JSON, верен ли синтаксис кода
// внутри Code-нод, не ссылаются ли связи на несуществующие ноды.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const file = process.argv[2];
const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log('JSON разобран. Нод:', wf.nodes.length);

let bad = 0;
for (const n of wf.nodes) {
  if (n.type === 'n8n-nodes-base.code') {
    const tmp = path.join(os.tmpdir(), 'chk-' + n.id + '.js');
    // n8n выполняет код Code-ноды внутри асинхронной функции, поэтому await
    // на верхнем уровне там законен. Проверяя файл как есть, мы получали бы
    // ложную ошибку на каждой ноде, которая что-то скачивает.
    fs.writeFileSync(tmp, '(async () => {\n' + n.parameters.jsCode + '\n})();');

    // Проверяем дважды, и вот почему. На Windows антивирус успевает открыть
    // только что созданный файл раньше, чем до него доберётся node, и проверка
    // падает с ПУСТЫМ сообщением об ошибке — то есть выглядит как синтаксическая
    // ошибка там, где её нет. Один такой ложный сбой уже случился 04.10.2026.
    //
    // Отличить настоящую ошибку от помехи просто: у настоящей node печатает
    // текст с номером строки. Пустая ошибка — повод повторить, а не ругаться.
    let ошибка = null;
    for (let попытка = 1; попытка <= 2; попытка++) {
      try {
        execFileSync('node', ['--check', tmp], { stdio: 'pipe' });
        ошибка = null;
        break;
      } catch (e) {
        ошибка = String(e.stderr || '').trim() || String(e.message || '').trim();
        // Настоящую синтаксическую ошибку повторять незачем — она не исчезнет.
        if (/SyntaxError/.test(ошибка)) break;
      }
    }

    if (!ошибка) {
      console.log('  OK   синтаксис:', n.name);
    } else {
      bad++;
      console.log('  СБОЙ синтаксис:', n.name);
      console.log(ошибка || '  (node не объяснил причину — возможна помеха антивируса, перезапустите)');
    }
    fs.unlinkSync(tmp);
  }
}

/**
 * Чего в песочнице Code-ноды n8n НЕТ.
 *
 * Список собран не из документации, а из пяти подряд падений на сервере
 * 02–03.10.2026. Код Code-ноды исполняется в отдельном процессе с урезанным
 * окружением, и каждое такое обращение видно только на запуске — то есть
 * стоит отдельного круга отладки. Дешевле поймать здесь.
 */
const ЗАПРЕЩЕНО = [
  { шаблон: /\bprocess\s*\./, имя: 'process', чем: 'значения передавать через настройки ноды' },
  { шаблон: /(^|[^.\w])fetch\s*\(/, имя: 'fetch', чем: 'this.helpers.httpRequest или встроенный https' },
  { шаблон: /\bAbortController\b/, имя: 'AbortController', чем: 'опция timeout самого запроса' },
  { шаблон: /(^|[^.\w])new\s+URL\s*\(/, имя: 'new URL', чем: 'разбор адреса вручную' }
];

for (const n of wf.nodes) {
  if (n.type !== 'n8n-nodes-base.code') continue;
  const строки = n.parameters.jsCode.split('\n');
  строки.forEach((строка, i) => {
    // Комментарии не считаем: в них эти слова как раз и объясняются.
    const без = строка.replace(/\/\/.*$/, '').replace(/\*.*$/, '');
    for (const з of ЗАПРЕЩЕНО) {
      if (з.шаблон.test(без)) {
        bad++;
        console.log(`  СБОЙ в «${n.name}», строка ${i + 1}: ${з.имя} в песочнице n8n недоступен`);
        console.log(`         чем заменить: ${з.чем}`);
        console.log(`         ${строка.trim().slice(0, 100)}`);
      }
    }
  });
}

const names = wf.nodes.map((n) => n.name);
for (const from of Object.keys(wf.connections || {})) {
  if (!names.includes(from)) { bad++; console.log('  СБОЙ: связь из несуществующей ноды', from); }
  for (const grp of wf.connections[from].main || []) {
    for (const c of grp) {
      if (!names.includes(c.node)) { bad++; console.log('  СБОЙ: связь в несуществующую ноду', c.node); }
    }
  }
}

// Ноды, в которые никто не ведёт и которые не триггеры — висящие.
const targets = new Set();
for (const from of Object.keys(wf.connections || {})) {
  for (const grp of wf.connections[from].main || []) for (const c of grp) targets.add(c.node);
}
for (const n of wf.nodes) {
  if (!targets.has(n.name) && !/Trigger/i.test(n.type)) {
    bad++; console.log('  СБОЙ: нода ни с чем не связана:', n.name);
  }
}

console.log(bad === 0 ? 'ПРОВЕРКА ПРОЙДЕНА' : 'ОШИБОК: ' + bad);
process.exit(bad === 0 ? 0 : 1);
