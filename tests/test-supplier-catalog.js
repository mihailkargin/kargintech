/**
 * Тесты: каталоги поставщиков ниши (src/supplier-catalog.js), 30.10.2026.
 * Запуск: node tests/test-supplier-catalog.js
 */
const К = require('../src/supplier-catalog');
const { разобратьПрайс } = require('../src/price-list');

let failures = 0;
function check(ok, label) {
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${label}`);
  if (!ok) failures++;
}

console.log('=== Выгрузка YML ===');
const yml = `<?xml version="1.0"?><yml_catalog date="2026-10-30"><shop><offers>
<offer id="1" available="true"><url>https://opt.example.ru/p/1</url><price>289.50</price><currencyId>RUR</currencyId>
<name><![CDATA[Бумага офисная А4 80 г/м2 500 листов Снегурочка]]></name><vendorCode>SN-80</vendorCode></offer>
<offer id="2" available="false"><url>https://opt.example.ru/p/2</url><price>100</price><currencyId>RUB</currencyId><name>Ручка шариковая синяя</name></offer>
<offer id="3"><url>https://opt.example.ru/p/3</url><price>5</price><currencyId>USD</currencyId><name>Папка-скоросшиватель</name></offer>
<offer id="4"><url>https://opt.example.ru/p/4</url><price>45</price><currencyId>RUB</currencyId><typePrefix>Папка</typePrefix><vendor>Бюрократ</vendor><model>скоросшиватель пластиковый А4</model></offer>
</offers></shop></yml_catalog>`;
const y = К.разобратьYml(yml);
check(y.ok && y.позиции.length === 2, 'взяты 2 предложения из 4 (нет в наличии и в долларах - не берутся)');
check(y.позиции[0].цена === 289.5 && y.позиции[0].артикул === 'SN-80', 'цена 289,50 и артикул прочитаны');
check(y.позиции[1].наименование === 'Папка Бюрократ скоросшиватель пластиковый А4', 'имя без <name> собрано из typePrefix + vendor + model');
check(!К.разобратьYml('<html>не выгрузка</html>').ok, 'HTML вместо YML - отказ с причиной');

console.log('=== Товар со страницы (schema.org) ===');
const карточка = `<html><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Бумага офисная А4 80 г/м2 500 л","sku":"A4-80","offers":{"@type":"Offer","price":"312.00","priceCurrency":"RUB","availability":"https://schema.org/InStock"}}</script></html>`;
const т = К.товарИзСтраницы(карточка);
check(т && т.цена === 312 && т.артикул === 'A4-80', 'карточка товара: имя, цена 312, артикул');
const список = `<script type="application/ld+json">[{"@type":"Product","name":"А","offers":{"price":"1"}},{"@type":"Product","name":"Б","offers":{"price":"2"}}]</script>`;
check(К.товарИзСтраницы(список) === null, 'два товара на странице - это список, цена не берётся');
check(К.товарИзСтраницы('<script type="application/ld+json">{"@type":"Product","name":"Х","offers":{"@type":"AggregateOffer","lowPrice":"100","highPrice":"300"}}</script>') === null,
  'диапазон «от 100 до 300» - не одна цена, не берётся');
check(К.товарИзСтраницы('<script type="application/ld+json">{"@type":"Product","name":"Х","offers":{"price":"100","availability":"OutOfStock"}}</script>') === null,
  'нет в наличии - не берётся');

console.log('=== Товар со страницы (microdata и мета-теги) ===');
const микро = `<div itemscope itemtype="https://schema.org/Product"><h1 itemprop="name">Ручка шариковая синяя 0,7 мм</h1>
<div itemprop="offers" itemscope itemtype="https://schema.org/Offer"><meta itemprop="priceCurrency" content="RUB"><span itemprop="price">1 250,50 ₽</span></div></div>`;
const м = К.товарИзСтраницы(микро);
check(м && м.цена === 1250.5 && м.наименование === 'Ручка шариковая синяя 0,7 мм', 'microdata: имя и цена «1 250,50 ₽»');
check(К.товарИзСтраницы(микро.replace('RUB', 'USD')) === null, 'microdata в долларах - не берётся');
check(К.товарИзСтраницы(микро + микро) === null, 'два товара microdata - список, не берётся');
check(К.товарИзСтраницы(микро.replace('</div></div>', '<span itemprop="price">999</span></div></div>')) === null, 'две разные цены у одного товара - не берётся');
const ог = '<meta property="og:title" content="Папка-скоросшиватель А4"><meta property="product:price:amount" content="45.90"><meta property="product:price:currency" content="RUB">';
check((К.товарИзСтраницы(ог) || {}).цена === 45.9, 'мета-теги product:price:amount + og:title - 45,90');
check(К.товарИзСтраницы('<meta property="og:title" content="Каталог"><p>Цена 100 ₽</p>') === null, 'цена только в тексте, без разметки - не берётся');

console.log('=== Карта сайта и robots.txt ===');
check(К.ссылкиИзSitemap('<sitemapindex><sitemap><loc>https://a.ru/s1.xml</loc></sitemap></sitemapindex>').вложенные[0] === 'https://a.ru/s1.xml', 'sitemapindex - вложенные карты');
check(К.ссылкиИзSitemap('<urlset><url><loc>https://a.ru/p/1</loc></url><url><loc>https://a.ru/p/2</loc></url></urlset>').страницы.length === 2, 'urlset - адреса страниц');
const robots = К.разобратьRobots('User-agent: *\nDisallow: /cart\nDisallow: /search\nAllow: /search/catalog\nSitemap: https://a.ru/sitemap.xml\n');
check(robots.карты[0] === 'https://a.ru/sitemap.xml', 'карта сайта из robots.txt');
check(!К.разрешено(robots, 'https://a.ru/cart/1') && К.разрешено(robots, 'https://a.ru/catalog/bumaga'), 'Disallow соблюдается, прочее можно');
check(К.разрешено(robots, 'https://a.ru/search/catalog/x') && !К.разрешено(robots, 'https://a.ru/search?q=1'), 'более длинное Allow побеждает');
const свой = К.разобратьRobots('User-agent: *\nDisallow:\n\nUser-agent: KarginTech\nDisallow: /\n');
check(!К.разрешено(свой, 'https://a.ru/x'), 'запрет для KarginTech по имени - соблюдается, даже если «*» можно');

console.log('=== Отбор страниц по словам ниши ===');
const адреса = ['https://a.ru/catalog/bumaga-ofisnaya-a4', 'https://a.ru/catalog/ruchki-sharikovye', 'https://a.ru/catalog/mebel/stul', 'https://a.ru/about'];
const отбор = К.отобратьСтраницы(адреса, ['Бумага офисная А4', 'Ручка шариковая'], 10);
check(отбор.length === 2 && отбор.includes(адреса[0]) && отбор.includes(адреса[1]), 'взяты бумага и ручки, стул и «о компании» - нет');

console.log('=== Расценки подрядчика с таблицы страницы ===');
const страница = `<table><tr><th>Наименование работ</th><th>Ед. изм.</th><th>Цена, руб.</th></tr>
<tr><td>Устройство кровли из наплавляемых материалов в два слоя</td><td>м2</td><td>450</td></tr>
<tr><td>Разборка покрытий кровель из рулонных материалов</td><td>м2</td><td>120</td></tr>
<tr><td>Монтаж водостока; с материалом</td><td>п.м.</td><td>от 800</td></tr></table>`;
const таблицы = К.таблицыИзHtml(страница);
const прайс = разобратьПрайс(таблицы[0], { имяФайла: 'расценки.csv' });
check(прайс.ok && прайс.позиции.length === 2, 'две расценки взяты; «от 800» - не одна цена, не берётся');
check(прайс.позиции[0].цена === 450 && прайс.позиции[0].единица === 'м2', 'устройство кровли - 450 ₽ за м2');

console.log('=== Сверка позиции тендера с каталогом ===');
const сегодня = new Date('2026-10-30T10:00:00Z');
const запись = К.записьКаталога({ домен: 'opt.example.ru', имя: 'ООО «Опт»', сайт: 'https://opt.example.ru', источник: { тип: 'yml', url: 'https://opt.example.ru/yml.xml' } }, [
  { наименование: 'Бумага офисная А4 80 г/м2 500 листов Снегурочка', цена: 289.5, url: 'https://opt.example.ru/p/1' },
  { наименование: 'Бумага офисная А4 100 г/м2 500 листов', цена: 520, url: 'https://opt.example.ru/p/5' },
  { наименование: 'Бумага', цена: 10 },
  { наименование: 'Кабель ВВГнг(А)-FRLS 3х1,5', цена: 95 },
  { наименование: 'Монтаж кабеля в лотке', цена: 60, единица: 'м' }
], new Date('2026-10-29T00:00:00Z'));
const каталог = К.построитьКаталог(запись);
const н = К.найтиВКаталоге({ name: 'Бумага для офисной техники А4, 80 г/м2, 500 листов', unit: 'пачка' }, каталог);
check(н && н.строка.цена === 289.5, 'бумага 80 г/м2 нашлась - 289,50, не 100 г/м2 за 520');
check(К.найтиВКаталоге({ name: 'Бумага для офисной техники А4 90 г/м2' }, каталог) === null, 'бумага 90 г/м2 - в каталоге её нет, совпадения нет');
check(К.найтиВКаталоге({ name: 'Бумага' }, каталог) === null, 'позиция из одного слова - не сверяется (мало слов)');
check(К.найтиВКаталоге({ name: 'Кабель ВВГ 3х1,5' }, каталог) === null, 'ВВГ не сопоставлен с ВВГнг-FRLS - марки расходятся');
check(К.найтиВКаталоге({ name: 'Кабель монтажный медный' }, каталог) === null, 'товар не сопоставлен с работой «Монтаж кабеля»');
const п = К.поставщикиИзКаталогов({ name: 'Бумага офисная А4 80 г/м2 500 листов' }, [каталог], сегодня);
check(п.length === 1 && п[0].name === 'ООО «Опт»' && п[0].url === 'https://opt.example.ru/p/1' && п[0].изКаталога, 'поставщик в виде поиска: имя, ссылка на товар');
check(/от 2026-10-29/.test(п[0].priceNote) && /289.5/.test(п[0].evidence), 'дата каталога и строка-подтверждение в записи');
check(К.поставщикиИзКаталогов({ name: 'Бумага офисная А4 80 г/м2 500 листов' }, [каталог], new Date('2026-11-20T00:00:00Z')).length === 0,
  'каталог старше 14 дней в расчёт не идёт');

console.log('=== Каталоги с диска (app/supplier-catalog-run.js) ===');
const fs = require('fs');
const os = require('os');
const path = require('path');
const КР = require('../app/supplier-catalog-run');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kat-'));
fs.mkdirSync(path.join(tmp, 'catalogs'));
fs.writeFileSync(path.join(tmp, 'catalogs', 'opt.example.ru.json'), JSON.stringify(запись));
fs.writeFileSync(path.join(tmp, 'catalogs', 'zakryt.ru.json'), JSON.stringify({ домен: 'zakryt.ru', прайсЗакрыт: true, позиции: [] }));
fs.writeFileSync(path.join(tmp, 'catalogs', 'bity.ru.json'), '{не json');
const прочитано = КР.прочитатьКаталоги({ каталогДанных: tmp });
check(прочитано.length === 1 && прочитано[0].домен === 'opt.example.ru', 'прочитан каталог с ценами; «прайс закрыт» и битый файл в сверку не идут');
check(КР.прочитатьКаталоги({ каталогДанных: tmp })[0] === прочитано[0], 'неизменённый файл не перестраивается (взят из памяти)');
const стр = КР.изСтраницыHtml(страница, 'https://krovlya.example.ru/ceny');
check(стр.ok && стр.позиции.length === 2 && стр.позиции[0].url === 'https://krovlya.example.ru/ceny', 'страница расценок - две расценки со ссылкой на страницу');
check(!КР.изСтраницыHtml('<p>Звоните, цены по запросу</p>', 'https://x.ru').ok, 'страница без таблицы цен - отказ с причиной');
console.log('=== Дилерский прайс из файла (локальный источник) ===');
fs.mkdirSync(path.join(tmp, 'catalog-files'));
fs.writeFileSync(path.join(tmp, 'catalog-files', 'diler.csv'), 'Наименование;Ед.;Цена с НДС\nБумага офисная А4 80 г/м2 500 листов;пачка;265,00\nРучка шариковая синяя 0,7 мм;шт;12,40\n');
const дата = new Date('2026-10-28T09:00:00Z');
fs.utimesSync(path.join(tmp, 'catalog-files', 'diler.csv'), дата, дата);
(async () => {
  const журнал = [];
  const r = await КР.обновитьКаталог({ домен: 'diler.example.ru', имя: 'ООО «Дилер»', сайт: 'https://diler.example.ru', источники: [{ тип: 'локальный', путь: 'diler.csv' }] }, { каталогДанных: tmp }, журнал);
  check(r.ok && r.позиций === 2, `дилерский прайс загружен: 2 позиции (${r.отказ || ''})`);
  const з = JSON.parse(fs.readFileSync(path.join(tmp, 'catalogs', 'diler.example.ru.json'), 'utf8'));
  check(з.обновлено.startsWith('2026-10-28') && з.источник.тип === 'дилерский прайс', 'дата цены - дата файла (28.10), источник «дилерский прайс»');
  const к = КР.прочитатьКаталоги({ каталогДанных: tmp }).find((x) => x.домен === 'diler.example.ru');
  const п2 = К.поставщикиИзКаталогов({ name: 'Бумага для офисной техники А4 80 г/м2 500 листов' }, [к], сегодня);
  check(п2.length === 1 && п2[0].price === 265 && п2[0].name === 'ООО «Дилер»', 'позиция тендера нашлась в дилерском прайсе - 265 ₽');
  const вне = await КР.обновитьКаталог({ домен: 'x.ru', источники: [{ тип: 'локальный', путь: '../../etc/passwd' }] }, { каталогДанных: tmp }, []);
  check(!вне.ok && /вне/.test(вне.отказ), 'путь за пределы catalog-files - отказ, посторонний файл не читается');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\nСБОЕВ: ${failures}` : '\nВсе проверки прошли');
  process.exit(failures ? 1 : 0);
})();
