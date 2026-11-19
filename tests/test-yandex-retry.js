/**
 * Тесты: повторы поиска Яндекса при 429 (живой расчёт 12.11.2026 - позиция
 * осталась без поставщиков из-за лимита 1 запрос/с). Без сети: запросы
 * перехватываются подменой app/http.
 * Запуск: node tests/test-yandex-retry.js
 */
const path = require('path');
const httpPath = require.resolve('../app/http');

let calls = 0;
let план = []; // ответы ПОИСКа по порядку: {код}
require.cache[httpPath] = {
  exports: {
    взять: async (url) => {
      if (String(url).includes('searchapi.api.cloud.yandex.net')) {
        calls++;
        const к = план.length ? план.shift() : 200;
        return { ok: к === 200, код: к, тело: к === 200 ? Buffer.from(
          '<yandexsearch><response><results><grouping>'
          + '<group><doc><url>https://opt-test.ru/a4</url><title>Бумага А4 оптом</title></doc></group>'
          + '</grouping></results></response></yandexsearch>') : Buffer.from('rate') };
      }
      throw new Error('страницы в этом тесте не качаются');
    }
  }
};

process.env.YANDEX_API_KEY = 'y';
process.env.YANDEX_FOLDER_ID = 'f';
const Р = require('../app/yandex-run');

let failures = 0;
function check(ok, label) {
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${label}`);
  if (!ok) failures++;
}

const бумага = { name: 'Бумага для офисной техники (Бумага офисная А4 80 г/м2 500 листов)', quantity: 100, unit: 'пачка' };

(async () => {
  console.log('=== 429: повторяем и добираемся до выдачи ===');
  calls = 0; план = [429, 200, 200, 200];
  const р1 = await Р.найтиПоставщиковЯндексом([бумага], {}, []);
  check(р1.issues.length === 0, `без замечаний (${р1.issues.join(';') || 'ok'})`);
  check(р1.расход.поисков === 3, `повтор учтён в расходе (${р1.расход.поисков})`);
  check(calls === 3, `второй запрос после 429 прошёл (${calls} вызовов)`);

  console.log('=== 429 трижды подряд: попытки кончаются, зацикливания нет ===');
  calls = 0; план = [429, 429, 429, 200];
  const р2 = await Р.найтиПоставщиковЯндексом([бумага], {}, []);
  check(calls === 4, `три попытки + следующий запрос, не больше (${calls})`);

  console.log('=== 403: без повторов, очередь честно не досчитывается ===');
  calls = 0; план = [403];
  const ручка = { name: 'Ручка шариковая автоматическая синяя', unit: 'шт' };
  const планшет = { name: 'Планшет для бумаг А4', unit: 'шт' };
  const р3 = await Р.найтиПоставщиковЯндексом([бумага, { name: 'Скрепки металлические 28 мм оцинкованные', unit: 'шт' }, ручка, планшет], {}, []);
  check(calls === 5, `рабочие в полёте досчитали свои позиции (2 запроса каждый), повторов 403 нет (${calls})`);
  check(р3.issues.some((s) => /техническим причинам/.test(s)), 'замечание о незавершённом поиске');
  check(р3.поЗаказчикам.get('Планшет для бумаг А4').length === 0, 'позиция, не взятая до отказа, получила пустой результат');

  console.log(failures ? `\nСБОЕВ: ${failures}` : '\nВсе проверки прошли');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e.stack); process.exit(1); });
