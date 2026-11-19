/**
 * Тесты: поставщики ниши через Yandex Cloud без модели (04.11.2026) -
 * отбор сайтов по выдачам, остановка на отказе ключа, порядок «сначала Claude,
 * при отказе Яндекс» в app/niche-suppliers.js. Без сети: поиск, посредник и
 * скачивание прайсов подменены.
 * Запуск: node tests/test-niche-yandex.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

const каталог = fs.mkdtempSync(path.join(os.tmpdir(), 'niche-'));
process.env.STATE_DIR = каталог;
process.env.CLIENTS_DIR = каталог;
process.env.ANTHROPIC_API_KEY = 'k';
process.env.CLAUDE_PROXY_URL = 'http://p';
process.env.YANDEX_API_KEY = 'y';
process.env.YANDEX_FOLDER_ID = 'f';
delete process.env.SUPPLIER_SEARCH;

let failures = 0;
function check(ok, label) {
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${label}`);
  if (!ok) failures++;
}

const Я = require('../src/yandex-search');
const ссылка = (д) => ({ url: `https://${д}/catalog/x`, домен: д, заголовок: д });
const п = (name) => ({ name, unit: 'шт' });

(async () => {
  console.log('=== Отбор сайтов ниши по выдачам ===');
  const выдачи = [
    { позиция: п('Бумага офисная А4'), ссылки: [ссылка('opt-bumaga.ru'), ссылка('kanc.ru'), ссылка('zakupki.gov.ru'), ссылка('random1.ru')] },
    { позиция: п('Скрепки металлические 28 мм'), ссылки: [ссылка('opt-bumaga.ru'), ссылка('kanc.ru'), ссылка('random2.ru')] },
    { позиция: п('Ручка шариковая синяя'), ссылки: [ссылка('kanc.ru'), ссылка('ru.wikipedia.org'), ссылка('random3.ru')] }
  ];
  const н = Я.поставщикиНишиИзВыдач(выдачи, 'товар');
  check(н.map((x) => x.домен).join(',') === 'kanc.ru,opt-bumaga.ru', `по 2+ позициям, больше позиций - первыми (${н.map((x) => x.домен).join(',')})`);
  check(!н.some((x) => /random/.test(x.домен)), 'сайт из одной выдачи не берётся');
  check(!Я.поставщикиНишиИзВыдач([выдачи[0], выдачи[0]], 'товар').some((x) => x.домен === 'zakupki.gov.ru'), 'площадка закупок не поставщик');
  check(!Я.поставщикиНишиИзВыдач([выдачи[2], выдачи[2]], 'товар').some((x) => /wikipedia/.test(x.домен)), 'поддомен справочника отсекается');
  check(н[0].вид === 'поставщик' && н[0].источники.length === 0 && /по 3 позициям ниши из 3/.test(н[0].цитата), 'вид, без готовых адресов прайса, обоснование числом');
  check(Я.поставщикиНишиИзВыдач([выдачи[0]], 'работа').length === 3, 'группа из одной позиции - берутся сайты её выдачи');
  check(Я.поставщикиНишиИзВыдач([выдачи[0]], 'работа')[0].вид === 'подрядчик', 'работы - подрядчик');
  check(Я.поставщикиНишиИзВыдач([], 'товар').length === 0, 'пустые выдачи - пусто');

  console.log('=== Запрос по позиции ниши ===');
  check(Я.запросНиши(п('Бумага для офисной техники 17.12.14.110-00000005')) === 'Бумага для офисной техники оптом прайс', `товар без кода КТРУ (${Я.запросНиши(п('Бумага для офисной техники 17.12.14.110-00000005'))})`);
  check(/расценки подрядчик$/.test(Я.запросНиши(п('Ремонт кровли здания школы'))), 'работа - расценки');
  check(Я.запросНиши(п('')) === '', 'пустая позиция - без запроса');

  console.log('=== Поиск ниши Яндексом: остановка на отказе ключа ===');
  const Р = require('../app/yandex-run');
  let запросов = 0;
  const журнал = [];
  const р = await Р.поставщикиНишиЯндексом([{ вид: 'товар', позиции: [п('Бумага офисная А4'), п('Скрепки металлические'), п('Ручка шариковая')] }], {}, журнал, {
    искать: async (запрос, я, расход) => { запросов++; расход.поисков++; return запросов === 2 ? { ссылки: [], ошибка: 'поиск Яндекса: код 403 forbidden' } : { ссылки: [ссылка('kanc.ru')], ошибка: null }; }
  });
  check(запросов === 2 && /403/.test(р.стоп || ''), `после 403 запросов больше нет (${запросов})`);
  check(р.поставщики.length === 1 && р.поставщики[0].домен === 'kanc.ru', 'найденное до отказа сохранено');
  process.env.YANDEX_API_KEY = '';
  const р2 = await Р.поставщикиНишиЯндексом([{ вид: 'товар', позиции: [п('Бумага')] }], {}, [], {
    искать: async () => { throw new Error('без ключа поиск вызываться не должен'); }
  });
  process.env.YANDEX_API_KEY = 'y';
  check(/YANDEX_API_KEY/.test(р2.стоп || '') && !р2.поставщики.length, 'без ключа - отказ с названием настройки, поиска нет');

  console.log('=== niche-suppliers: Claude отказал - нишу ищет Яндекс ===');
  fs.writeFileSync(path.join(каталог, 'kargin.json'), JSON.stringify({ имя: 'kargin' }));
  fs.writeFileSync(path.join(каталог, 'kargin-parsed.json'), JSON.stringify({ '1': {}, '2': {} }));
  for (const н of ['1', '2']) {
    fs.writeFileSync(path.join(каталог, `verify-${н}.json`), JSON.stringify({ позиции: [п('Бумага офисная А4 80 г/м2'), п('Скрепки металлические 28 мм')] }));
  }
  let claude = 0;
  require.cache[require.resolve('../app/proxy')] = { exports: { взятьЧерезПосредника: async () => { claude++; return { ok: false, код: 403, тело: Buffer.from('{}') }; } } };
  require.cache[require.resolve('../app/supplier-catalog-run')] = { exports: {
    обновитьКаталог: async () => ({ ok: false, отказ: 'тест без сети' }), прочитатьКаталоги: () => []
  } };
  let группЯндексу = [];
  require.cache[require.resolve('../app/yandex-run')].exports = {
    настройкиЯндекса: Р.настройкиЯндекса,
    поставщикиНишиЯндексом: async (группы) => {
      группЯндексу.push(...группы.map((г) => г.вид));
      return { поставщики: [{ ...Я.поставщикиНишиИзВыдач(выдачи, 'товар')[0] }], стоп: null, расход: { рублей: 2.93 } };
    }
  };
  const { поставщикиНиши } = require('../app/niche-suppliers');
  const итог = await поставщикиНиши('kargin', { лимитДолл: 3 });
  check(итог.ok, `сбор прошёл (${итог.сбой || 'ok'})`);
  check(claude === 1, `Claude спрошен один раз (${claude})`);
  check(группЯндексу.join(',') === 'товар', `Яндекс искал оставшуюся группу (${группЯндексу.join(',')})`);
  check(итог.ok && итог.поставщики.length === 1 && итог.поставщики[0].домен === 'kanc.ru', 'поставщик Яндекса в итоге, прайс - кодом');
  check(итог.ok && /Yandex Cloud ≈ 2.93 ₽/.test(итог.стоимость), `расход Яндекса назван (${итог.стоимость})`);
  check((итог.журнал || []).some((с) => /Claude отказал/.test(с)), 'в журнале причина перехода');

  console.log('=== SUPPLIER_SEARCH=yandex - Claude не спрашивается ===');
  process.env.SUPPLIER_SEARCH = 'yandex'; claude = 0; группЯндексу = [];
  const итог2 = await поставщикиНиши('kargin', { лимитДолл: 3 });
  check(итог2.ok && claude === 0 && группЯндексу.length === 1, `Яндекс основной (Claude ${claude}, групп Яндексу ${группЯндексу.length})`);
  delete process.env.SUPPLIER_SEARCH;

  console.log('=== Ни Claude, ни Яндекса - честный отказ ===');
  process.env.ANTHROPIC_API_KEY = ''; process.env.YANDEX_API_KEY = '';
  const итог3 = await поставщикиНиши('kargin', {});
  check(!итог3.ok && /Yandex Cloud/.test(итог3.сбой), `отказ называет оба источника (${итог3.сбой})`);

  fs.rmSync(каталог, { recursive: true, force: true });
  console.log(failures ? `\nСБОЕВ: ${failures}` : '\nВсе проверки прошли');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log(e.stack); process.exit(1); });
