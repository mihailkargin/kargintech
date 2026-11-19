/**
 * Проверка конвертера от начала до конца. Запускается ВНУТРИ контейнера
 * конвертера, его же модулем Node:
 *
 *     docker compose exec -T converter node - < deploy/converter/selftest.js
 *
 * Почему проверка такая, а не «порт отвечает». Конвертер может подняться,
 * отчитаться об успехе и выдать документ с пустыми страницами — так бывает,
 * когда LibreOffice не нашёл шрифтов. Формально успех, фактически потеря
 * всего текста, и узнал бы об этом только клиент. Поэтому проверяется
 * весь путь: документ создаётся, пересохраняется и читается НАШИМ парсером,
 * тем самым, который работает в бою. Совпал текст — работает всё звено.
 *
 * Берём .rtf, а не .doc: RTF — текстовый формат, его можно собрать здесь же
 * несколькими строками, и для этого не нужно хранить в проекте двоичный
 * образец. Путь внутри LibreOffice у .rtf и .doc один и тот же.
 */
const http = require('http');
const { extractText } = require('/opt/tender/extract-text');

const PHRASE = 'Техническое задание на поставку';
const NUMBER = '1 234 567,89';

let failures = 0;
const check = (ok, message) => {
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${message}`);
  if (!ok) failures++;
};

/**
 * RTF хранит не-ASCII символы кодами. Кириллицу подставляем как \uN? —
 * N это код UTF-16, знак вопроса обязателен, это замена для читалок,
 * не понимающих Юникод.
 */
function rtfEscape(text) {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === 0x5c || code === 0x7b || code === 0x7d) out += '\\' + ch;
    else if (code < 128) out += ch;
    else out += `\\u${code}?`;
  }
  return out;
}

const rtf = Buffer.from(
  '{\\rtf1\\ansi\\ansicpg1251\\deff0{\\fonttbl{\\f0\\froman Times New Roman;}}\n' +
  `\\f0\\fs24 ${rtfEscape(PHRASE)}\\par\n` +
  `${rtfEscape('Начальная цена: ' + NUMBER + ' руб.')}\\par\n` +
  '}',
  'latin1'
);

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: Number(process.env.PORT || 3000), path, method },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  console.log('\n=== 1. Отвечает ли сам LibreOffice ===');
  const health = await request('GET', '/health');
  check(health.status === 200, `/health отдал код ${health.status}`);
  let info = {};
  try {
    info = JSON.parse(health.body.toString('utf8'));
  } catch (e) {
    check(false, `/health вернул не JSON: ${health.body.toString('utf8').slice(0, 200)}`);
  }
  check(info.ok === true, `LibreOffice отозвался: ${info.soffice || info.issue || 'нет ответа'}`);

  console.log('\n=== 2. Пересохранение старого формата ===');
  const conv = await request('POST', '/convert?name=%D0%A2%D0%97.rtf', rtf);
  if (conv.status !== 200) {
    check(false, `конвертер вернул код ${conv.status}: ${conv.body.toString('utf8').slice(0, 400)}`);
    console.log(`\nПРОВАЛЕНО ПРОВЕРОК: ${failures + 1}`);
    process.exit(1);
  }
  check(true, `получен ответ, ${conv.body.length} байт, формат ${conv.headers['x-converted-to']}`);
  check(conv.body[0] === 0x50 && conv.body[1] === 0x4b, 'результат действительно ZIP (DOCX)');

  console.log('\n=== 3. Текст читается нашим парсером ===');
  // Это главная проверка. Если шрифтов нет, здесь будет пустота —
  // при том, что шаги 1 и 2 пройдут.
  const parsed = extractText(conv.body, 'ТЗ.docx');
  check(parsed.ok === true, `парсер прочитал файл${parsed.ok ? '' : ': ' + parsed.issue}`);
  check(parsed.text.includes(PHRASE), `кириллица на месте: искали «${PHRASE}»`);
  check(parsed.text.includes('1 234 567') || parsed.text.replace(/\s/g, '').includes('1234567'),
    'цифры не потерялись');
  if (!parsed.text.includes(PHRASE)) {
    console.log(`  что получилось вместо текста: «${parsed.text.slice(0, 300)}»`);
  }

  console.log('\n=== 4. Отказ honest, а не тихий ===');
  const bad = await request('POST', '/convert?name=%D1%84%D0%B0%D0%B9%D0%BB.pdf', Buffer.from('%PDF-1.4'));
  check(bad.status === 400, `PDF отвергнут кодом ${bad.status}, а не принят молча`);
  const empty = await request('POST', '/convert?name=x.doc', Buffer.alloc(0));
  check(empty.status === 400, `пустое тело отвергнуто кодом ${empty.status}`);

  console.log(`\n${failures === 0 ? 'КОНВЕРТЕР РАБОТАЕТ — проверено на реальном пересохранении' : 'ПРОВАЛЕНО ПРОВЕРОК: ' + failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.log(`\nПРОВЕРКА ОБОРВАЛАСЬ: ${e.message}`);
  process.exit(1);
});
