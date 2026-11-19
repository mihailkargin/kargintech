/**
 * Тесты запросов КП: src/kp.js, app/mail.js (подставные SMTP и IMAP на
 * локальном порту, без шифрования - только в проверке), app/kp-run.js.
 * Запуск: node tests/test-kp.js
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const К = require('../src/kp');
const почта = require('../app/mail');
const КП = require('../app/kp-run');

let failures = 0;
const check = (ok, message) => {
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${message}`);
  if (!ok) failures++;
};
const section = (name) => console.log(`\n=== ${name} ===`);

(async () => {
  section('Почта со страницы поставщика');
  const html = `<html><script>var x="spy@sentry.io"</script><body>
    <a href="mailto:Sales@Kabel-Opt.ru?subject=x">Отдел продаж</a> info&#64;kabel-opt.ru
    noreply@kabel-opt.ru, logo@2x.png, hr@kabel-opt.ru, partner@gmail.com</body></html>`;
  const адреса = К.почтыСоСтраницы(html, 'https://www.kabel-opt.ru/catalog/vvg');
  check(адреса[0] === 'sales@kabel-opt.ru' && адреса.length === 2, `сначала продажи своего домена, не больше двух (${адреса})`);
  check(!адреса.some((a) => /sentry|noreply|png|^hr@/.test(a)), 'адреса из скриптов, noreply, отдел кадров и картинки отброшены');
  check(К.почтыСоСтраницы('<p>телефон +7 900</p>', 'https://x.ru').length === 0, 'нет почты на странице - пусто, а не догадка');

  section('Письмо-запрос');
  const п = К.письмоКП({ ид: 'ABCD2345', позиции: [{ наименование: 'Кабель ВВГнг 3х2,5', количество: 1500, единица: 'м', характеристики: 'медь, ГОСТ 31996' }] });
  check(п.тема === 'Запрос цены [КП-ABCD2345]' && К.МЕТКА.test(п.тема), 'метка в теме');
  check(/Количество: 1500 \(м\)/.test(п.текст) && /ГОСТ 31996/.test(п.текст) && /kargintech\.ru$/.test(п.текст), 'количество, требования из ТЗ, подпись последней строкой');
  // Дословная строка ТЗ живой закупки 0326100005026000005 (21.10.2026).
  const сырая = '| Бумага для офисной техники (Бумага для офисной техники белая формата А4) | Код позиции КТРУ: 17.12.14.110-00000004 | Предназначена для черно-белой и цветной печати | Да | Установлено в соответствии с п. 1 ГОСТ Р 57641-2017 | Масса бумаги площадью 1 кв. м: 80 г | Белизна по CIE: ≥ 146';
  const т = К.требования(сырая, 'Бумага для офисной техники (Бумага для офисной техники белая формата А4)');
  check(!/\||КТРУ|^Да|Установлено в соответствии/.test(т) && /80 г/.test(т) && /146/.test(т), `требования без разделителей, кода КТРУ и служебных ячеек (${т})`);
  const двеБумаги = 'Масса бумаги площадью 1м2, грамм; ≥ 80 и < 90; Количество листов в пачке, штука; ≥ 500; Цветность; Белая; Масса бумаги площадью 1м2, грамм; ≥ 200 и < 210; Количество листов в пачке, штука; ≥ 10'.replace(/; /g, ' | ');
  const т2 = К.требования(двеБумаги, '');
  check(/≥ 80/.test(т2) && !/≥ 200|≥ 10$/.test(т2), `характеристики соседнего товара отрезаны на повторе (${т2})`);
  check(К.требования('а'.repeat(300) + ' | ' + 'б'.repeat(300), '').length <= 500, 'требования не длиннее предела и не рвутся на полуслове');
  check(!/прайс|наценк|ООО «Клиент»/i.test(п.текст), 'о клиенте в письме ничего нет');

  section('Разбор ответа');
  const ответ = 'Добрый день!\nЦена 98,50 руб. за метр с НДС, от 1000 м.\nДоставка 3 500 ₽.\n\nС уважением, Иван\n+7 900 000\n\n> Просим сообщить цену 1500 руб';
  const с = К.суммыВОтвете(ответ);
  check(с.length === 2 && с[0].сумма === 98.5 && с[1].сумма === 3500, `суммы из свежей части, без подписи и цитаты (${с.map((x) => x.сумма)})`);
  check(!К.текстОтвета(ответ).includes('> Просим'), 'цитата нашего письма отрезана');
  // Дословно ответ Комуса 21.10.2026 (Outlook): цитата после черты и «From:».
  const outlook = 'Номер обращения: [863946]\n\nДобрый день!\nУточните, пожалуйста, ваши реквизиты строго по следующему формату: ИНН: xxxxxxxxxx Код Партнера: xxxxxxx\n________________________________\nFrom: KarginTech <kargintech.postavka@gmail.com>\nSent: Wednesday\nSubject: Запрос цены [КП-XVQ27L39]\n\nПросим сообщить цену';
  const чистый = К.текстОтвета(outlook);
  check(/реквизиты/.test(чистый) && !/Просим сообщить|From:/.test(чистый), 'цитата Outlook (черта и From:) отрезана');
  check(К.отписка('Отпишите нас, пожалуйста. Отписаться') && !К.отписка('Цена 100 руб'), 'отказ распознаётся');

  section('Разбор письма (MIME)');
  const сырое = [
    'From: =?UTF-8?B?0J7QntCeINCa0LDQsdC10LvRjA==?= <sales@kabel-opt.ru>',
    'Subject: =?UTF-8?B?UmU6INCX0LDQv9GA0L7RgSDRhtC10L3RiyBb0JrQny1BQkNEMjM0NV0=?=',
    'Content-Type: multipart/alternative; boundary="b1"',
    '', '--b1', 'Content-Type: text/plain; charset=windows-1251', 'Content-Transfer-Encoding: quoted-printable', '',
    '=D6=E5=ED=E0 98 =F0=F3=E1.', '--b1', 'Content-Type: text/html; charset=utf-8', '', '<p>html</p>', '--b1--', ''
  ].join('\r\n');
  const р = почта.разобратьПисьмо(Buffer.from(сырое, 'latin1'));
  check(р.тема === 'Re: Запрос цены [КП-ABCD2345]', `тема раскодирована (${р.тема})`);
  check(р.почтаОт === 'sales@kabel-opt.ru' && /ООО Кабель/.test(р.от), 'отправитель');
  check(р.текст === 'Цена 98 руб.', `текст из windows-1251 quoted-printable (${р.текст})`);

  section('SMTP на подставном сервере');
  const принято = [];
  const smtp = net.createServer((s) => {
    s.write('220 test\r\n');
    let данные = false;
    let буф = '';
    s.on('data', (c) => {
      буф += c.toString();
      if (данные) {
        if (буф.includes('\r\n.\r\n')) { принято.push(буф); данные = false; буф = ''; s.write('250 ok\r\n'); }
        return;
      }
      let i;
      while ((i = буф.indexOf('\r\n')) >= 0) {
        const с2 = буф.slice(0, i); буф = буф.slice(i + 2);
        if (/^EHLO/.test(с2)) s.write('250-test\r\n250 AUTH LOGIN\r\n');
        else if (/^AUTH LOGIN/.test(с2)) s.write('334 VXNlcm5hbWU6\r\n');
        else if (с2 === Buffer.from('kp@kargintech.ru').toString('base64')) s.write('334 UGFzc3dvcmQ6\r\n');
        else if (с2 === Buffer.from('секрет').toString('base64')) s.write('235 ok\r\n');
        else if (/^(MAIL|RCPT)/.test(с2)) s.write('250 ok\r\n');
        else if (с2 === 'DATA') { s.write('354 go\r\n'); данные = true; }
        else if (с2 === 'QUIT') { s.write('221 bye\r\n'); s.end(); }
        else s.write('535 нет\r\n');
      }
    });
  });
  await new Promise((ok) => smtp.listen(0, '127.0.0.1', ok));
  const н = { user: 'kp@kargintech.ru', password: 'секрет', smtpHost: '127.0.0.1', smtpPort: smtp.address().port, imapHost: '127.0.0.1', imapPort: 0, имя: 'KarginTech' };
  const от = await почта.отправить(н, { кому: 'sales@kabel-opt.ru', ...п }, { tls: false });
  check(от.ok && принято.length === 1, `письмо принято сервером (${от.сбой || ''})`);
  const тело = принято[0] || '';
  check(/Subject: =\?UTF-8\?B\?/.test(тело) && Buffer.from(тело.split('\r\n\r\n')[1].replace(/\s|\./g, ''), 'base64').toString().includes('Кабель ВВГнг'), 'тема и текст в UTF-8 base64');
  const плохо = await почта.отправить({ ...н, password: 'неверно' }, { кому: 'a@b.ru', тема: 'x', текст: 'y' }, { tls: false });
  check(!плохо.ok && !плохо.сбой.includes('неверно'), 'неверный пароль - отказ, пароля в сообщении нет');
  check(!(await почта.отправить(н, { кому: 'не почта', тема: 'x', текст: 'y' }, { tls: false })).ok, 'кривой адрес не отправляется');
  check(!(await почта.отправить(null, { кому: 'a@b.ru' })).ok, 'без настроек - «почта не настроена»');
  smtp.close();

  section('IMAP на подставном сервере');
  const письмоIMAP = Buffer.from(сырое, 'latin1');
  const помечено = [];
  const imap = net.createServer((s) => {
    s.write('* OK test\r\n');
    let буф = '';
    s.on('data', (c) => {
      буф += c.toString();
      let i;
      while ((i = буф.indexOf('\r\n')) >= 0) {
        const с2 = буф.slice(0, i); буф = буф.slice(i + 2);
        const [т, cmd] = [с2.split(' ')[0], с2.split(' ').slice(1).join(' ')];
        if (/^LOGIN/.test(cmd)) s.write(cmd.includes('"секрет"') ? `${т} OK\r\n` : `${т} NO auth\r\n`);
        else if (/^SELECT/.test(cmd)) s.write(`* 2 EXISTS\r\n${т} OK\r\n`);
        else if (/^UID SEARCH/.test(cmd)) s.write(`* SEARCH 7\r\n${т} OK\r\n`);
        else if (/^UID FETCH 7/.test(cmd)) { s.write(`* 1 FETCH (UID 7 BODY[] {${письмоIMAP.length}}\r\n`); s.write(письмоIMAP); s.write(`)\r\n${т} OK\r\n`); }
        else if (/^UID STORE/.test(cmd)) { помечено.push(cmd); s.write(`${т} OK\r\n`); }
        else if (/^LOGOUT/.test(cmd)) { s.write(`* BYE\r\n${т} OK\r\n`); s.end(); }
        else s.write(`${т} BAD\r\n`);
      }
    });
  });
  await new Promise((ok) => imap.listen(0, '127.0.0.1', ok));
  const нI = { ...н, imapPort: imap.address().port };
  const вх = await почта.новыеПисьма(нI, { tls: false });
  check(вх.ok && вх.письма.length === 1 && вх.письма[0].тема.includes('[КП-ABCD2345]'), `письмо прочитано, литерал разобран (${вх.сбой || ''})`);
  check(помечено.length === 1 && /\\Seen/.test(помечено[0]), 'письмо помечено прочитанным');
  const вхПлохо = await почта.новыеПисьма({ ...нI, password: 'неверно' }, { tls: false });
  check(!вхПлохо.ok && !вхПлохо.сбой.includes('неверно'), 'неверный пароль IMAP - отказ без пароля в сообщении');
  imap.close();

  section('ИНН покупателя');
  const { иннВерен } = require('../src/inn');
  check(иннВерен('7707083893') && иннВерен('500100732259'), 'настоящие ИНН юрлица и ИП проходят');
  check(!иннВерен('7707083894') && !иннВерен('123') && !иннВерен('0000000000') && !иннВерен('77070838 93'), 'опечатка и мусор не проходят');

  section('Рассылка и ответы (kp-run)');
  const ПОКУПАТЕЛЬ = { название: 'ООО «Тест»', инн: '7707083893', согласие: true };
  const кат = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-'));
  fs.writeFileSync(path.join(кат, 'verify-0301100049626001767.json'), JSON.stringify({
    позиции: [{ name: 'Кабель ВВГнг 3х2,5', quantity: 1500, unit: 'м' }, { name: 'Розетка', quantity: 40, unit: 'шт' }],
    поставщики: [
      { позиция: 'Кабель ВВГнг 3х2,5', name: 'ООО Кабель', url: 'https://kabel-opt.ru/p1' },
      { позиция: 'Розетка', name: 'ООО Кабель', url: 'https://www.kabel-opt.ru/p2' },
      { позиция: 'Розетка', name: 'Электро', url: 'https://electro.example.org/r' },
      { позиция: 'Розетка', name: 'Без почты', url: 'https://nomail.ru/r' }
    ],
    тз: { поПозициям: { 'Кабель ВВГнг 3х2,5': 'медь, ГОСТ 31996' } }
  }));
  const страницы = { 'https://kabel-opt.ru/p1': '<a href="mailto:sales@kabel-opt.ru">x</a>', 'https://electro.example.org/r': 'opt@electro.example.org', 'https://nomail.ru/r': 'тел. +7' };
  const ушло = [];
  const почтовик = {
    настройки: н,
    отправить: async (письмо) => { ушло.push(письмо); return { ok: true }; },
    новыеПисьма: async () => ({ ok: true, письма: [] })
  };
  const сеть = async (u) => ({ ok: !!страницы[u], тело: Buffer.from(страницы[u] || '') });
  // У «Без почты» почты нет и на страницах контактов, у «Электро» она только на /contacts/.
  страницы['https://electro.example.org/contacts/'] = страницы['https://electro.example.org/r'];
  страницы['https://electro.example.org/r'] = '<p>Розетка двойная</p>';
  const r1 = await КП.разослать('0301100049626001767', { клиент: 'site-abc123', почтовик, сеть, пауза: 0, каталог: кат, покупатель: ПОКУПАТЕЛЬ });
  check(r1.ok && r1.отправлено === 2 && ушло.length === 2, `одному поставщику одно письмо, без почты - не пишем (${r1.отправлено})`);
  const кабель = ушло.find((x) => x.кому === 'sales@kabel-opt.ru');
  check(кабель && /Покупатель: ООО «Тест», ИНН 7707083893\./.test(кабель.текст), 'в письме реквизиты покупателя, разрешённые им');
  check(кабель && /Кабель ВВГнг/.test(кабель.текст) && /Розетка/.test(кабель.текст) && /1500 \(м\)/.test(кабель.текст) && /ГОСТ 31996/.test(кабель.текст), 'позиции поставщика собраны в одно письмо с количеством и ТЗ');
  const безРазрешения = await КП.разослать('0301100049626001767', { клиент: 'site-abc123', почтовик, сеть, пауза: 0, каталог: кат, покупатель: null });
  check(безРазрешения.отправлено === 0 && /не разрешил/.test(безРазрешения.причина), 'без разрешения клиента запросы цены не отправляются');
  const r2 = await КП.разослать('0301100049626001767', { клиент: 'site-abc123', почтовик, сеть, пауза: 0, каталог: кат, покупатель: ПОКУПАТЕЛЬ });
  check(r2.отправлено === 0 && ушло.length === 2, 'повторно по той же закупке тем же поставщикам не пишем');
  const ст = КП.состояниеКП(['0301100049626001767', '../../etc'], { каталог: кат });
  check(ст['0301100049626001767'].отправлено === 2 && ст['0301100049626001767'].безПочты === 1 && Object.keys(ст).length === 1, 'состояние: отправлено 2, без почты 1, подстановка пути отвергнута');

  // Ответы: один настоящий, одна отписка, одно чужое письмо.
  const индекс = JSON.parse(fs.readFileSync(path.join(кат, 'kp-index.json'), 'utf8'));
  const [идКабель, идЭлектро] = Object.keys(индекс);
  почтовик.новыеПисьма = async () => ({ ok: true, письма: [
    { тема: `Re: Запрос цены [КП-${идКабель}]`, почтаОт: 'sales@kabel-opt.ru', текст: 'Цена 98,50 руб. за метр.\n\n> Просим' },
    { тема: `Re: [КП-${идЭлектро}]`, почтаОт: 'opt@electro.example.org', текст: 'Отписаться' },
    { тема: 'Скидки недели', почтаОт: 'spam@x.ru', текст: 'купите' }
  ] });
  const о = await КП.собратьОтветы({ почтовик, каталог: кат });
  check(о.ok && о.ответов === 1 && о.новые[0].клиент === 'site-abc123', 'настоящий ответ разложен по закупке и клиенту, чужое письмо пропущено');
  const ст2 = КП.состояниеКП(['0301100049626001767'], { каталог: кат })['0301100049626001767'];
  check(ст2.ответы[0].суммы[0].сумма === 98.5 && !ст2.ответы[0].текст.includes('> Просим'), 'сумма найдена, цитата отрезана');
  const стоп = JSON.parse(fs.readFileSync(path.join(кат, 'kp-stop.json'), 'utf8'));
  check(стоп.адреса.includes('opt@electro.example.org') && стоп.домены.includes('example.org'), 'отписка внесена в стоп-список');
  fs.writeFileSync(path.join(кат, 'verify-0301100049626001768.json'), JSON.stringify({ позиции: [], поставщики: [{ позиция: 'Розетка', name: 'Электро', url: 'https://electro.example.org/r' }] }));
  const r3 = await КП.разослать('0301100049626001768', { клиент: 'site-abc123', почтовик, сеть, пауза: 0, каталог: кат, покупатель: ПОКУПАТЕЛЬ });
  check(r3.отправлено === 0, 'отписавшемуся по другой закупке не пишем');

  // Дневной предел.
  fs.writeFileSync(path.join(кат, 'kp-day.json'), JSON.stringify({ день: new Date().toISOString().slice(0, 10), отправлено: КП.ПИСЕМ_В_ДЕНЬ }));
  fs.writeFileSync(path.join(кат, 'verify-0301100049626001769.json'), JSON.stringify({ позиции: [], поставщики: [{ позиция: 'X', name: 'Новый', url: 'https://kabel-new.ru/x' }] }));
  страницы['https://kabel-new.ru/x'] = 'sales@kabel-new.ru';
  const r4 = await КП.разослать('0301100049626001769', { клиент: 'site-abc123', почтовик, сеть, пауза: 0, каталог: кат, покупатель: ПОКУПАТЕЛЬ });
  check(r4.отправлено === 0 && /в день/.test((r4.журнал || []).join(' ')), 'дневной предел соблюдён');
  check(!(await КП.разослать('../x', { почтовик, каталог: кат })).ok, 'кривой номер закупки - отказ');
  fs.rmSync(кат, { recursive: true, force: true });

  console.log('');
  if (failures) { console.log(`ПРОВЕРОК НЕ ПРОШЛО: ${failures}`); process.exit(1); }
  console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
})().catch((e) => { console.error(e); process.exit(1); });
