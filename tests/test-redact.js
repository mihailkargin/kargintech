/**
 * Тесты вырезания контактных данных.
 * Запуск: node tests/test-redact.js
 *
 * Здесь два разных класса ошибок, и оба проверяются отдельно:
 *
 *   НЕДОЧИСТКА — контакт уехал в модель. Ломает обещание клиенту о безопасности.
 *   ПЕРЕЧИСТКА — вырезано название юрлица или условие контракта. Ломает продукт
 *                тише: клиент видит заказчика «[ФИО]» и перестаёт доверять всему.
 */
const { redactContacts, isSafeToSend, MASK } = require('../src/redact');

let failures = 0;
const check = (ok, message) => {
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${message}`);
  if (!ok) failures++;
};
const section = (name) => console.log(`\n=== ${name} ===`);

section('Телефоны в разных написаниях');
[
  '+7 (495) 123-45-67',
  '+7(495)123-45-67',
  '8 495 123 45 67',
  '84951234567',
  '8-495-123-45-67',
  '+74951234567',
  '8 (4912) 12-34-56',
  '+7 495 123-45-67 доб. 204'
].forEach((phone) => {
  const r = redactContacts(`Телефон заказчика ${phone} для уточнений.`);
  check(!/\d{3}[-\s]?\d{2}[-\s]?\d{2}/.test(r.text) && r.text.includes(MASK.phone),
    `вырезан телефон «${phone}»`);
});

section('Электронная почта');
const mail = redactContacts('Заявки направлять на zakupki@mgkb.ru или ivanov.ii@mail.ru.');
check(!mail.text.includes('@'), 'адреса вырезаны полностью');
check(mail.removed.emails === 2, `оба адреса посчитаны (${mail.removed.emails})`);

section('Ф.И.О. контактного лица');
[
  'Иванов Иван Иванович',
  'Петрова Мария Сергеевна',
  'Иван Иванович Иванов',
  'Иванов И.И.',
  'Иванов И. И.',
  'И.И. Иванов',
  'Салтыков-Щедрин Михаил Евграфович'
].forEach((name) => {
  const r = redactContacts(`Контактное лицо — ${name}, вопросы по лоту.`);
  check(r.text.includes(MASK.name) || r.text.includes(MASK.contact), `вырезано имя «${name}»`);
});

section('Подписанные блоки забирают значение целиком');
const labeled = redactContacts(
  'Контактное лицо: Смит Джон\nАдрес электронной почты: a@b.ru\nКонтактный телефон: 8 (495) 000-00-00'
);
check(!labeled.text.includes('Смит Джон'),
  'иностранное имя без отчества вырезано по подписи, а не по шаблону');
check(labeled.removed.labeled >= 3, `все три подписанные строки обработаны (${labeled.removed.labeled})`);

section('ПЕРЕЧИСТКА: название юрлица не трогаем');
const hospital = redactContacts(
  'Заказчик: ГБУЗ «Городская клиническая больница им. Н.И. Пирогова» города Москвы'
);
check(hospital.text.includes('Н.И. Пирогова'),
  'больница имени человека осталась целой — иначе проверка контрагента уйдёт в пустоту');
check(hospital.removed.names === 0, 'имя в названии учреждения не посчитано как контакт');

const ip = redactContacts('Поставщик: ИП Иванов Иван Иванович, ИНН 771234567890');
check(ip.text.includes('Иванов Иван Иванович'),
  'имя индивидуального предпринимателя сохранено — это сторона договора, а не контактное лицо');
check(ip.text.includes('771234567890'), 'ИНН не принят за телефон и не вырезан');

const ipLong = redactContacts('Поставщик: Индивидуальный предприниматель Петров Пётр Петрович');
check(ipLong.text.includes('Петров Пётр Петрович'),
  'исключение работает и для полного написания «Индивидуальный предприниматель»');

const treasury = redactContacts('Управление Федерального Казначейства по городу Москве');
check(treasury.removed.names === 0,
  'три слова с большой буквы без отчества — не имя человека');

section('Кириллица и границы слова');
// В JavaScript \b и \w не считают буквами кириллицу. Шаблон вида \bИНН не
// совпадает никогда, и защита реквизитов молча перестаёт работать. Эти две
// проверки ловят именно такую поломку: ИНН из 12 цифр, начинающийся с 8,
// без защиты был бы вырезан как телефон.
const innFirst = redactContacts('ИНН 812345678901 указан в заявке.');
check(innFirst.text.includes('812345678901'),
  'ИНН в самом начале строки защищён — граница слова для кириллицы учтена');
check(innFirst.removed.phones === 0, 'двенадцатизначный ИНН не принят за телефон');

section('ПЕРЕЧИСТКА: реквизиты и числа остаются');
const req = redactContacts(
  'ИНН 7712345678, КПП 771201001, ОГРН 1027700132195, р/с 40702810400000001234, БИК 044525225'
);
check(req.removed.phones === 0, 'ни один реквизит не вырезан как телефон');
check(req.text.includes('40702810400000001234'), 'номер счёта сохранён');

const money = redactContacts('НМЦК составляет 8 000 000 000 ₽, обеспечение 80 000 000 руб.');
check(money.removed.phones === 0, 'сумма из одиннадцати цифр не принята за телефон');
check(money.text.includes('8 000 000 000'), 'сумма сохранена без изменений');

const reg = redactContacts('Извещение № 0318300173926000268 и закупка № 32211234567.');
check(reg.text.includes('0318300173926000268') && reg.text.includes('32211234567'),
  'реестровые номера 44-ФЗ и 223-ФЗ сохранены');

const dates = redactContacts('Срок подачи 19.09.2026, поставка до 31.12.2026.');
check(dates.removed.phones === 0 && dates.text.includes('19.09.2026'), 'даты сохранены');

section('ПЕРЕЧИСТКА: условия контракта не съедены');
const terms = redactContacts(
  'Исполнитель: обязан поставить товар в течение 30 дней с момента заключения контракта.'
);
check(terms.text.includes('обязан поставить товар в течение 30 дней'),
  'слово «Исполнитель» в тексте контракта не приводит к вырезанию условия');

section('СНИЛС и паспорт');
const snils = redactContacts('СНИЛС 112-233-445 95 указан в заявке.');
check(snils.text.includes(MASK.snils), 'СНИЛС вырезан');
const passport = redactContacts('Паспорт 45 12 № 123456 выдан отделением.');
check(passport.text.includes(MASK.passport), 'данные паспорта вырезаны');

section('Аудит-лог не хранит то, что вырезал');
const audited = redactContacts('Контактный телефон: +7 (495) 123-45-67, почта ivanov@mail.ru');
const dump = JSON.stringify(audited.log);
check(!/123-45-67|1234567|ivanov/.test(dump),
  'в журнале нет самих значений — иначе персональные данные переехали бы в лог');
check(audited.log.every((e) => e.type && typeof e.at === 'number' && typeof e.length === 'number'),
  'в журнале есть тип, позиция и длина каждого вырезанного фрагмента');
check(audited.total > 0 && audited.total === audited.log.length,
  `счётчик совпадает с числом записей (${audited.total})`);

section('Контрольная проверка перед отправкой');
const dirty = 'Вопросы: Сидоров Пётр Петрович, тел. +7 916 000-11-22, mail@x.ru';
const before = isSafeToSend(dirty);
check(!before.safe, 'до вырезания отправка запрещена');
check(before.findings.length >= 3, `названы все три вида утечки (${before.findings.length})`);

const after = isSafeToSend(redactContacts(dirty).text);
check(after.safe, `после вырезания отправка разрешена${after.safe ? '' : ': ' + after.findings.join('; ')}`);

const cleanDoc = isSafeToSend(
  'Объект закупки: поставка бумаги А4. НМЦК 1 200 000 ₽. ИНН заказчика 7712345678. ' +
  'Заказчик: ГБУЗ «ГКБ им. Н.И. Пирогова». Срок поставки 30.11.2026.'
);
check(cleanDoc.safe, `документ без контактов не помечается ложной тревогой${cleanDoc.safe ? '' : ': ' + cleanDoc.findings.join('; ')}`);

section('Повторный прогон ничего не портит');
const once = redactContacts(dirty).text;
const twice = redactContacts(once).text;
check(once === twice, 'вырезание применено дважды даёт тот же результат');

section('Пустой и битый вход');
check(redactContacts('').total === 0, 'пустая строка не ломает разбор');
check(redactContacts(null).text === '', 'отсутствие текста обработано без исключения');
check(isSafeToSend('').safe, 'пустой текст считается безопасным');

console.log(`\n${failures === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : 'ПРОВАЛЕНО ПРОВЕРОК: ' + failures}`);
process.exit(failures === 0 ? 0 : 1);
