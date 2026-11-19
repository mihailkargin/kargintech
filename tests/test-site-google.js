/**
 * Тесты сайта, 21.10.2026: вход через Google (обмен кода подменён),
 * восстановление пароля письмом (приложение подменено), товарные категории,
 * пример ленты до настройки, фильтр по региону.
 * Запуск: node tests/test-site-google.js
 */
const http = require('http');
const { создатьСайт } = require('../site/server');
const { открыть } = require('../site/db');
const А = require('../site/auth');
const Г = require('../site/google');
const { словаКатегорий } = require('../site/categories');
const { отобратьЛенту } = require('../site/pages-app');
const { регионЗаказчика, СПИСОК_РЕГИОНОВ } = require('../src/region');

let failures = 0;
const check = (ok, message) => { console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${message}`); if (!ok) failures++; };
const section = (name) => console.log(`\n=== ${name} ===`);

const КЛЮЧИ = { id: 'client-id.apps.googleusercontent.com', секрет: 's' };
const токен = (поля) => ['e30', Buffer.from(JSON.stringify(поля)).toString('base64url'), 'sig'].join('.');
let почтаGoogle = 'new@gmail.com';
const обмен = async () => ({ ok: true, idToken: токен({ iss: 'https://accounts.google.com', aud: КЛЮЧИ.id, exp: Math.floor(Date.now() / 1000) + 600, email: почтаGoogle, email_verified: true }) });

const письма = [];
let последниеНастройки = null;
async function приложение(путь, тело) {
  if (путь === '/reset-mail') { письма.push(тело); return { ok: true }; }
  if (путь === '/client-settings') { последниеНастройки = тело; return { ok: true }; }
  if (путь === '/tenders') {
    if (тело.клиент === 'site-demo000001') return { ok: true, тендеры: [{ номер: '0373200000000000001', объект: 'Поставка бумаги', закон: '44-ФЗ Электронный аукцион', нмцк: 100000, срок: '2099-01-01', регион: '77' }], обновлено: '2026-10-21', вОчереди: 0 };
    return { ok: true, тендеры: [], обновлено: null, вОчереди: 0 };
  }
  if (путь === '/search') return { ok: true, сводка: {} };
  return { ok: false, сбой: 'неизвестно' };
}

const db = открыть(':memory:');
const сайт = создатьСайт({ db, вПриложение: приложение, гугл: КЛЮЧИ, обменГугл: обмен, демо: 'site-demo000001', адресСайта: 'https://kargintech.ru' });
const безГугла = создатьСайт({ db: открыть(':memory:'), вПриложение: приложение, гугл: null });

function запрос(порт, метод, путь, { форма = null, cookie = '', origin = true } = {}) {
  return new Promise((ok, нет) => {
    const тело = форма ? new URLSearchParams(форма).toString() : '';
    const h = {};
    if (форма) { h['Content-Type'] = 'application/x-www-form-urlencoded'; h['Content-Length'] = Buffer.byteLength(тело); }
    if (cookie) h.Cookie = cookie;
    if (origin) h.Origin = `https://127.0.0.1:${порт}`;
    const req = http.request({ hostname: '127.0.0.1', port: порт, path: путь, method: метод, headers: h }, (res) => {
      const к = []; res.on('data', (c) => к.push(c));
      res.on('end', () => ok({ код: res.statusCode, з: res.headers, тело: Buffer.concat(к).toString('utf8') }));
    });
    req.on('error', нет); req.end(тело);
  });
}
const кука = (r, имя) => ([].concat(r.з['set-cookie'] || []).find((c) => c.startsWith(имя + '=')) || '').split(';')[0];

(async () => {
  await new Promise((ok) => сайт.сервер.listen(0, '127.0.0.1', ok));
  await new Promise((ok) => безГугла.сервер.listen(0, '127.0.0.1', ok));
  const п = сайт.сервер.address().port;
  const п2 = безГугла.сервер.address().port;
  const з = (...a) => запрос(п, ...a);

  section('Разбор токена Google');
  const сейчас = Date.now();
  const база = { iss: 'https://accounts.google.com', aud: КЛЮЧИ.id, exp: Math.floor(сейчас / 1000) + 60, email: 'A@Gmail.com', email_verified: true };
  check(Г.разобратьТокен(токен(база), КЛЮЧИ, сейчас).почта === 'a@gmail.com', 'верный токен - почта в нижнем регистре');
  check(!Г.разобратьТокен(токен({ ...база, aud: 'чужой' }), КЛЮЧИ, сейчас).ok, 'токен для чужого сайта - отказ');
  check(!Г.разобратьТокен(токен({ ...база, iss: 'https://evil.example' }), КЛЮЧИ, сейчас).ok, 'токен не от Google - отказ');
  check(!Г.разобратьТокен(токен({ ...база, exp: 1 }), КЛЮЧИ, сейчас).ok, 'просроченный токен - отказ');
  check(!Г.разобратьТокен(токен({ ...база, email_verified: false }), КЛЮЧИ, сейчас).ok, 'неподтверждённая почта - отказ');
  check(/client_id=client-id/.test(Г.адресВхода(КЛЮЧИ, 'https://kargintech.ru/auth/google/callback', 'ab')) , 'адрес входа содержит наш client_id');

  section('Кнопка и маршруты Google');
  check(/Войти с аккаунтом Google/.test((await з('GET', '/login')).тело), 'с ключами - кнопка на странице входа');
  check(!/аккаунтом Google/.test((await запрос(п2, 'GET', '/login')).тело), 'без ключей - кнопки нет');
  check((await запрос(п2, 'GET', '/auth/google')).код === 404, 'без ключей - маршрут закрыт');
  const старт = await з('GET', '/auth/google');
  const st = (кука(старт, '__Host-gst').split('=')[1]) || '';
  check(старт.код === 303 && /accounts\.google\.com/.test(старт.з.location) && st.length === 32, 'переход к Google с меткой state в cookie');
  check((await з('GET', `/auth/google/callback?code=abcdefghijk&state=${st}`)).код === 400, 'возврат без cookie state - отказ');
  check((await з('GET', `/auth/google/callback?code=abcdefghijk&state=${'0'.repeat(32)}`, { cookie: `__Host-gst=${st}` })).код === 400, 'чужой state - отказ');

  // Новая почта: регистрация только с кодом приглашения.
  const возврат = await з('GET', `/auth/google/callback?code=abcdefghijk&state=${st}`, { cookie: `__Host-gst=${st}` });
  const pend = кука(возврат, '__Host-gpend');
  check(возврат.код === 200 && /new@gmail\.com/.test(возврат.тело) && /Код приглашения/.test(возврат.тело) && pend, 'новая почта - форма с кодом приглашения');
  check(!db.пользовательПоПочте('new@gmail.com'), 'без кода пользователь не создан');
  const плохой = await з('POST', '/auth/google/finish', { форма: { invite: 'AAAA-BBBB-CCCC', company: 'ООО Г', consent: '1' }, cookie: pend });
  check(плохой.код === 400 && !db.пользовательПоПочте('new@gmail.com'), 'неверный код - отказ');
  const код = А.кодПриглашения(); db.создатьПриглашение(код, 'тест');
  const чужой = await з('POST', '/auth/google/finish', { форма: { invite: код, company: 'ООО Г', consent: '1' }, cookie: '__Host-gpend=' + 'f'.repeat(48) });
  check(чужой.код === 400 && !db.пользовательПоПочте('new@gmail.com'), 'без своей отметки Google - отказ');
  const готово = await з('POST', '/auth/google/finish', { форма: { invite: код, company: 'ООО Г', consent: '1' }, cookie: pend });
  const у = db.пользовательПоПочте('new@gmail.com');
  check(готово.код === 303 && готово.з.location === '/app/onboarding' && у && кука(готово, '__Host-sid'), 'с кодом - пользователь создан и вошёл');
  check(db.компания(у.company_id).calcs_limit === 5, 'пробный период новой компании - 5 расчётов');
  check(!А.парольВерен('', у.pass_hash) && !А.парольВерен('длинныйпароль1', у.pass_hash), 'пароля у пользователя Google нет');
  const ещё = await з('POST', '/auth/google/finish', { форма: { invite: код, company: 'ООО Г2', consent: '1' }, cookie: pend });
  check(ещё.код === 400, 'отметку Google нельзя использовать повторно');

  // Существующая почта: вход.
  const ст2 = await з('GET', '/auth/google'); const st2 = кука(ст2, '__Host-gst').split('=')[1];
  const вход = await з('GET', `/auth/google/callback?code=abcdefghijk&state=${st2}`, { cookie: `__Host-gst=${st2}` });
  check(вход.код === 303 && вход.з.location === '/app' && кука(вход, '__Host-sid'), 'зарегистрированная почта - сразу вход');

  section('Пример ленты до настройки и категории');
  const сид = кука(готово, '__Host-sid');
  const лента = await з('GET', '/app', { cookie: сид });
  check(лента.код === 200 && /Пример ленты/.test(лента.тело) && /Поставка бумаги/.test(лента.тело), 'до настройки кабинет открывается и показывает пример');
  check(!/\/app\/t\/0373200000000000001/.test(лента.тело) && !/В избранное/.test(лента.тело), 'в примере нет действий и ссылок на чужие закупки');
  check(/Москва/.test(лента.тело), 'в карточке виден регион');
  const онб = await з('GET', '/app/onboarding', { cookie: сид });
  check(/Канцелярские товары и бумага/.test(онб.тело) && /name="cat"/.test(онб.тело) && /Пропустить/.test(онб.тело), 'стартовая настройка - категории галочками');
  const csrf = (онб.тело.match(/name="csrf" value="([^"]*)"/) || [])[1];
  const пусто = await з('POST', '/app/onboarding', { форма: { csrf }, cookie: сид });
  check(пусто.код === 400, 'без категорий и слов - отказ');
  const выбор = await з('POST', '/app/onboarding', { форма: `csrf=${csrf}&cat=office&cat=furniture&cat=evil&words=` , cookie: сид });
  check(выбор.код === 303, 'выбор категорий сохраняется');
  const н = db.настройки(у.company_id);
  check(н.категории.join() === 'office,furniture' && н.слова.includes('бумага офисная') && н.слова.includes('мебель'), 'в поиск уходят слова выбранных категорий, неизвестная отброшена');
  check(последниеНастройки && (последниеНастройки.поля.окпд || []).includes('17.12') && последниеНастройки.поля.окпд.includes('31.01'), 'коды ОКПД2 выбранных категорий уходят в приложение');
  {
    const стрН = await з('GET', '/app/settings', { cookie: сид });
    const к2 = (стрН.тело.match(/name="csrf" value="([^"]*)"/) || [])[1];
    check(/Дополнительные коды ОКПД2/.test(стрН.тело) && /17\.12/.test(стрН.тело), 'в настройках поле кодов и коды категорий');
    await з('POST', '/app/settings', { форма: `csrf=${к2}&cat=office&okpd=${encodeURIComponent('22.29, abc, 32.99.12')}`, cookie: сид });
    const ок = (последниеНастройки.поля.окпд || []);
    check(ок.includes('22.29') && ок.includes('32.99.12') && !ок.includes('abc'), 'свои коды добавляются, неверные отбрасываются');
    check((db.настройки(у.company_id).своиКоды || []).join() === '22.29,32.99.12', 'свои коды сохранены');
  }
  {
    const сКодом = [{ номер: '1', срок: '2099-01-01', окпд: ['17.12'] }, { номер: '2', срок: '2099-01-01', окпд: ['31.01'] }, { номер: '3', срок: '2099-01-01', окпд: [] }];
    check(отобратьЛенту(сКодом, {}, { okpd: '17.12.14' }).map((x) => x.номер).join() === '1', 'фильтр ленты по коду ОКПД2');
  }
  check(словаКатегорий(['office'], ['Бумага Офисная', 'кабель']).join('|') === 'бумага офисная|канцелярские товары|бланочная продукция|канцтовары|кабель', 'свои слова добавляются без повторов');
  check(словаКатегорий(['office', 'electro', 'food', 'building', 'auto', 'fuel', 'textile', 'furniture', 'household']).length === 30, 'предел 30 фраз');

  section('Заявка на тариф без подключённой оплаты');
  {
    const стр = await з('GET', '/app/billing', { cookie: сид });
    check(/Оставить заявку/.test(стр.тело) && !/>Оплатить</.test(стр.тело), 'без ключей ЮKassa - «Оставить заявку», а не «Оплатить»');
    const к = (стр.тело.match(/name="csrf" value="([^"]*)"/) || [])[1];
    const з1 = await з('POST', '/app/billing/request', { форма: { csrf: к, tariff: 'pro' }, cookie: сид });
    check(з1.код === 200 && /Заявка на тариф «Про» отправлена/.test(з1.тело), 'заявка принята');
    const з2 = await з('POST', '/app/billing/request', { форма: { csrf: к, tariff: 'pro' }, cookie: сид });
    check(/уже отправлена/.test(з2.тело), 'повторная заявка в течение часа не дублируется');
    check((await з('POST', '/app/billing/request', { форма: { csrf: к, tariff: 'nope' }, cookie: сид })).код === 400, 'неизвестный тариф - отказ');
  }

  section('Выгрузка ленты в Excel');
  {
    const ex = await new Promise((ok, нет) => {
      const req = http.request({ hostname: '127.0.0.1', port: п, path: '/app/export.xlsx', method: 'GET', headers: { Cookie: сид } }, (res) => {
        const к = []; res.on('data', (c) => к.push(c)); res.on('end', () => ok({ код: res.statusCode, з: res.headers, буфер: Buffer.concat(к) }));
      });
      req.on('error', нет); req.end();
    });
    check(ex.код === 200 && ex.буфер.slice(0, 2).toString() === 'PK' && /attachment/.test(ex.з['content-disposition'] || ''), 'файл Excel отдаётся вложением');
    check((await запрос(п, 'GET', '/app/export.xlsx')).код === 303, 'без входа - на страницу входа');
    const { лентаВExcel } = require('../site/export');
    const б = лентаВExcel([{ номер: '0373200000000000001', объект: 'Бумага', нмцк: 1000, срок: '2099-01-02', регион: '77', разбор: { обеспечения: { заявка: { требуется: false } } } }], {});
    check(б.slice(0, 2).toString() === 'PK', 'книга собирается');
  }

  section('Массовый расчёт');
  {
    const стр = await з('GET', '/app/billing', { cookie: сид });
    const к = (стр.тело.match(/name="csrf" value="([^"]*)"/) || [])[1];
    const чужие = await з('POST', '/app/calc-many', { форма: `csrf=${к}&n=03732000000000000099&n=12345678901`, cookie: сид });
    check(чужие.код === 303 && /history\?msg=/.test(чужие.з.location) && db.расчётыПоТендеру(у.company_id, '12345678901').length === 0, 'номера не из своей ленты - расчёт не ставится');
    const ист = await з('GET', чужие.з.location, { cookie: сид });
    check(/не найдены в ленте/.test(ист.тело), 'сказано, почему ничего не поставлено');
    check((await з('POST', '/app/calc-many', { форма: `csrf=x&n=12345678901`, cookie: сид })).код === 403, 'без ключа формы - 403');
  }

  section('Сортировка по выгоде');
  {
    const { упорядочитьПоВыгоде } = require('../site/pages-app');
    const и = (х, л, доп = {}) => JSON.stringify({ закупкаИзвестна: true, позицийСЦеной: 2, позицийПоПотолку: 0, запасПроцент: х, запасПроцентЛучший: л, ...доп });
    const список = ['a', 'b', 'c', 'd', 'e'].map((номер) => ({ номер }));
    const расчёты = {
      a: { status: 'готов', totals: и(-5, 3) },
      b: { status: 'готов', totals: и(8, 12) },
      c: { status: 'готов', totals: и(1, 1, { позицийПоПотолку: 2 }) },
      e: { status: 'идёт' }
    };
    check(упорядочитьПоВыгоде(список, расчёты, 'profit').map((x) => x.номер).join('') === 'bacde', 'рассчитанные по запасу первыми; по одним ценам заказчика и нерассчитанные - после');
    check(упорядочитьПоВыгоде(список, расчёты, 'deadline').map((x) => x.номер).join('') === 'abcde', 'другая сортировка порядок не меняет');
  }

  section('Самопроверка');
  {
    const беды = await сайт.самопроверка();
    check(беды.length === 1 && /приложение/.test(беды[0]), 'приложение не ответило про самопроверку - это беда, а не «всё хорошо»');
    const ещё = await сайт.самопроверка();
    check(ещё.length === 1, 'беда возвращается, но владельцу повторно не шлётся (раз в 6 часов)');
  }

  section('Регион');
  check(регионЗаказчика({ ikz: '262230903180123090100100100010001000' }) === '23', 'регион из КПП внутри ИКЗ (Краснодар)');
  check(регионЗаказчика({ inn: '7202208163', kpp: '720301001' }) === '72', 'регион из КПП заказчика 223-ФЗ');
  check(регионЗаказчика({ kpp: '997750001' }) === null, 'код 99 (крупнейшие) - не определён');
  check(СПИСОК_РЕГИОНОВ.slice(0, 3).map((r) => r[1]).join() === 'Москва,Санкт-Петербург,Севастополь', 'города федерального значения - первыми');
  const т = [{ номер: '1', регион: '77', срок: '2099-01-01' }, { номер: '2', регион: '50', срок: '2099-01-01' }, { номер: '3', регион: null, срок: '2099-01-01' }];
  check(отобратьЛенту(т, {}, { region: ['77', '78'] }).map((x) => x.номер).join() === '1', 'фильтр по региону');
  check(отобратьЛенту(т, {}, {}).length === 3, 'без фильтра - все, включая неопределённый регион');
  {
    // Предмет закупки (владелец 28.10.2026): смешанные видны в обоих фильтрах.
    const п = [{ номер: 'г', объект: 'Поставка металла', срок: '2099-01-01' },
      { номер: 'р', объект: 'Выполнение работ по ремонту кровли', срок: '2099-01-01' },
      { номер: 'с', объект: 'x', окпд: ['43.91', '24.10'], срок: '2099-01-01' }];
    check(отобратьЛенту(п, {}, { kind: 'goods' }).map((x) => x.номер).join() === 'г,с', 'фильтр «Товары» - товары и смешанные');
    check(отобратьЛенту(п, {}, { kind: 'works' }).map((x) => x.номер).join() === 'р,с', 'фильтр «Работы и услуги» - работы и смешанные');
  }
  {
    const { близость } = require('../src/region');
    check(близость('77', '77') === 0 && близость('50', '77') === 1 && близость('78', '77') === 2 && близость(null, '77') === 3, 'близость к складу: свой регион, свой округ, другой, неизвестно');
    const { лента: стрЛенты } = require('../site/pages-app');
    const html = стрЛенты({ пользователь: { csrf: 'x', role: 'client' }, тендеры: т, отметки: {}, п: { sort: 'near' }, обновлено: null, поиск: null, вОчереди: 0, регионСклада: '50' });
    check(html.indexOf('№ 2') < html.indexOf('№ 1') && html.indexOf('№ 1') < html.indexOf('№ 3'), '«Ближе к складу»: Московская обл., затем Москва (тот же округ), затем неизвестный регион');
  }

  section('Обеспечения в ленте');
  {
    const { текстОбеспечения } = require('../site/pages-app');
    const сОбесп = [
      { номер: 'a', срок: '2099-01-01', разбор: { обеспечения: { заявка: { требуется: false, процент: null, сумма: null } } } },
      { номер: 'b', срок: '2099-01-01', разбор: { обеспечения: { заявка: { требуется: true, процент: 1, сумма: 2250 } } } },
      { номер: 'c', срок: '2099-01-01', разбор: { обеспечения: null } }
    ];
    check(отобратьЛенту(сОбесп, {}, { nosec: '1' }).map((x) => x.номер).join() === 'a', '«Без обеспечения заявки» - только где карточка говорит «не требуется», неизвестное не показывается');
    check(текстОбеспечения({ требуется: false }) === 'не требуется' && текстОбеспечения(null) === 'не указано', 'не требуется / не указано');
    check(/2\s250 ₽ \(1%\)/.test(текстОбеспечения({ требуется: true, процент: 1, сумма: 2250 })), 'сумма и процент');
    check(текстОбеспечения({ требуется: true, процент: 0.5, сумма: null }) === '0,5%', 'только процент, с запятой');
    const спец = [{ номер: 'k', объект: 'Поставка канцелярских товаров', срок: '2099-01-01', разбор: { наименования: ['Скобы для степлера №10', 'Бумага А4'] } }, { номер: 'm', объект: 'Мебель', срок: '2099-01-01', разбор: null }];
    check(отобратьЛенту(спец, {}, { q: 'скобы' }).map((x) => x.номер).join() === 'k', 'ключевое слово находит закупку по позиции спецификации');
  }

  section('Восстановление пароля');
  const ф = await з('GET', '/forgot');
  check(ф.код === 200 && /Восстановление пароля/.test(ф.тело), 'страница открывается');
  check(/href="\/forgot"/.test((await з('GET', '/login')).тело), 'на странице входа есть «Забыли пароль?»');
  const нет = await з('POST', '/forgot', { форма: { email: 'nobody@test.ru' } });
  check(нет.код === 200 && /Если адрес зарегистрирован/.test(нет.тело) && письма.length === 0, 'незнакомая почта - тот же ответ, письма нет');
  const да = await з('POST', '/forgot', { форма: { email: 'NEW@gmail.com' } });
  check(да.код === 200 && /Если адрес зарегистрирован/.test(да.тело) && письма.length === 1, 'знакомая почта - тот же ответ, письмо отправлено');
  const ссылка = письма[0] && письма[0].ссылка;
  check(/^https:\/\/kargintech\.ru\/reset\/[a-f0-9]{64}$/.test(ссылка || '') && письма[0].почта === 'new@gmail.com', 'в письме ссылка на наш сайт');
  check((await з('POST', '/forgot', { форма: { email: 'x@test.ru' }, origin: false })).код === 403, 'форма без Origin - 403');
  const путь = ссылка.replace('https://kargintech.ru', '');
  check((await з('GET', путь)).код === 200, 'ссылка открывает смену пароля');
  const смена = await з('POST', путь, { форма: { password: 'новыйдлинныйпароль' } });
  check(смена.код === 303 && А.парольВерен('новыйдлинныйпароль', db.пользовательПоПочте('new@gmail.com').pass_hash), 'пароль сменён');
  check((await з('GET', путь)).код === 410, 'ссылка одноразовая');
  for (let i = 0; i < 3; i++) await з('POST', '/forgot', { форма: { email: 'new@gmail.com' } });
  check((await з('POST', '/forgot', { форма: { email: 'new@gmail.com' } })).код === 429, 'частые запросы - ограничение');

  section('Переключатель регистрации');
  {
    const базаОткр = открыть(':memory:');
    const открытый = создатьСайт({ db: базаОткр, вПриложение: приложение, гугл: null, регистрацияОткрыта: true, чатВладельца: '555' });
    await new Promise((ok) => открытый.сервер.listen(0, '127.0.0.1', ok));
    const по = открытый.сервер.address().port;
    const стр = await запрос(по, 'GET', '/register');
    check(!/name="invite"[^>]*required/.test(стр.тело) && /если есть/.test(стр.тело), 'открыто: код приглашения необязателен');
    const р = await запрос(по, 'POST', '/register', { форма: { company: 'ООО Открытая', email: 'open@test.ru', password: 'длинныйпароль1', consent: '1' } });
    check(р.код === 303 && р.з.location === '/app/onboarding', 'открыто: регистрация без кода');
    {
      const к = кука(р, '__Host-sid');
      const стрТ = await запрос(по, 'GET', '/app/billing', { cookie: к });
      const csrf2 = (стрТ.тело.match(/name="csrf" value="([^"]*)"/) || [])[1];
      await запрос(по, 'POST', '/app/billing/request', { форма: { csrf: csrf2, tariff: 'base' }, cookie: к });
      const сообщения = базаОткр.взятьИзОчереди(10);
      check(сообщения.some((с) => с.chat_id === '555' && /Заявка на тариф/.test(с.text)), 'Telegram владельца на сайте не привязан - сигнал уходит на запасной чат');
    }
    const плохой = await запрос(по, 'POST', '/register', { форма: { invite: 'XXXX-YYYY-ZZZZ', company: 'ООО Б', email: 'b@test.ru', password: 'длинныйпароль1', consent: '1' } });
    check(плохой.код === 400, 'открыто: неверный код всё равно отказ');
    открытый.сервер.close();
    // Закрыто по умолчанию (сайт выше создан без флага).
    const закр = await з('POST', '/register', { форма: { company: 'ООО З', email: 'z@test.ru', password: 'длинныйпароль1', consent: '1' } });
    check(закр.код === 400 && /приглашения/.test(закр.тело), 'закрыто: без кода отказ');
    require('../site/pages-public').РЕЖИМ.открыто = false;
  }

  сайт.сервер.close(); безГугла.сервер.close();
  console.log(failures ? `\nСБОЕВ: ${failures}` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
