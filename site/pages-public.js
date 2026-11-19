/**
 * ПУБЛИЧНЫЕ СТРАНИЦЫ: главная, вход, регистрация (по приглашению).
 *
 * Текст главной — по САЙТ-СТРУКТУРА.md. Правило проекта: «в маркетинге не
 * обещать того, что не контролируем». Поэтому возможности, которых ещё нет
 * (подготовка документов к подаче, автозапросы КП, коммерческие площадки),
 * помечены «в разработке», а пример расчёта — настоящий, с живой закупки.
 */
const { esc, страница, сообщение } = require('./views');
const { ТАРИФЫ, ВНЕДРЕНИЕ, ВНЕДРЕНИЕ_ПУНКТЫ } = require('./tariffs');
/** Режим регистрации; выставляет site/server.js из REGISTRATION_OPEN. */
const РЕЖИМ = { открыто: false };
const { groupDigits } = require('../src/notify');

/**
 * Возможности на главной: плитка и окно с составом функции. Только то, что
 * работает; чего нет - с пометкой «в разработке».
 */
const ВОЗМОЖНОСТИ = [
  {
    ид: 'f-monitor', заголовок: 'Мониторинг 44-ФЗ и 223-ФЗ', кратко: 'Ежедневная лента закупок по вашим категориям.',
    иконка: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    пункты: [
      'Извещения ЕИС по 44-ФЗ и 223-ФЗ на этапе подачи заявок',
      'Отбор по товарным категориям, ключевым и стоп-словам',
      'Фильтры: НМЦК, регион заказчика, закон, способ определения поставщика, срок окончания подачи заявок',
      'Отметки об изменении извещения: срок подачи заявок, НМЦК, статус',
      'Избранное, скрытые закупки, сохранённые фильтры',
      'Уведомления о новых закупках в Telegram'
    ]
  },
  {
    ид: 'f-docs', заголовок: 'Разбор документации и ТЗ', кратко: 'Спецификация и обоснование НМЦК из документации заказчика.',
    иконка: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
    пункты: [
      'Спецификация: наименование, количество, единица измерения, характеристики товара',
      'Обоснование НМЦК: ценовые предложения по каждой позиции',
      'Форматы DOC, DOCX, XLS, XLSX, PDF, сканы, архивы ZIP, RAR, 7z',
      'Сверка каждой позиции со строкой документа, суммы - с НМЦК',
      'Закупки по цене единицы товара и изменения документации отмечаются отдельно'
    ]
  },
  {
    ид: 'f-suppliers', заголовок: 'Поиск поставщиков', кратко: 'Закупочные цены у производителей и оптовиков.',
    иконка: '<path d="M3 21h18M5 21V8l7-5 7 5v13"/><path d="M9 21v-6h6v6"/>',
    пункты: [
      'Производители и оптовые поставщики по наименованию и характеристикам из ТЗ',
      'Цена за единицу со ссылкой на страницу поставщика, контакты',
      'Пересчёт фасовки в единицу измерения закупки',
      'Маркетплейсы и доски объявлений не используются',
      'Запросы коммерческих предложений поставщикам от KarginTech - в разработке'
    ],
    тариф: 'Тарифы Про и Макс.'
  },
  {
    ид: 'f-calc', заголовок: 'Расчёт денег и рисков', кратко: 'Себестоимость, безубыточная цена, обеспечения.',
    иконка: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h2M12 11h2M16 11h0M8 15h2M12 15h2M8 19h8"/>',
    пункты: [
      'Себестоимость поставки: закупка, доставка, налог',
      'Безубыточная цена контракта - минимальная цена предложения',
      'Обеспечение заявки и исполнения контракта по данным извещения',
      'Антидемпинговые меры по ст. 37 44-ФЗ',
      'Требуемый объём оборотных средств',
      'Расчёт по лучшей и худшей цене поставщика, файл Excel с формулами'
    ]
  },
  {
    ид: 'f-price', заголовок: 'Ваш прайс и 1С', кратко: 'Расчёт по вашим закупочным ценам.',
    иконка: '<path d="M4 4h16v16H4z"/><path d="M4 9h16M9 9v11"/>',
    пункты: [
      'Загрузка прайс-листа XLSX или CSV, выгрузки номенклатуры из 1С',
      'Сопоставление позиций по наименованию, артикулу и характеристикам из ТЗ',
      'Цены прайса идут в расчёт как закупочные',
      'Прайс хранится на сервере в России и не передаётся в сторонние сервисы'
    ]
  },
  {
    ид: 'f-history', заголовок: 'История тендеров', кратко: 'Закупки, расчёты и решения в одном кабинете.',
    иконка: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    пункты: [
      'Найденные закупки с отметками: избранное, скрытые, решение по участию, заметки',
      'Архив расчётов с файлами Excel',
      'Поставщики из расчётов: «работаю», «не подходит», заметки'
    ]
  }
];

const иконка = (d) => `<div class="ico"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${d}</svg></div>`;

function главная(пользователь) {
  const начать = пользователь ? '/app' : '/register';
  // Пример - настоящий расчёт закупки 0119200000826000018 от 07.10.2026.
  const тело = `
<section class="hero"><div class="wrap">
  <div>
    <div class="eyebrow">Тендеры · 44-ФЗ и 223-ФЗ</div>
    <h1>Готовый расчёт тендера без ручной работы</h1>
    <p class="lead">KarginTech сам находит подходящие закупки, читает документацию и ТЗ, находит поставщиков с ценами и присылает расчёт: сколько нужно денег и при какой цене контракт выгоден.</p>
    <div class="cta">
      <a class="btn" href="${начать}">${пользователь ? 'Открыть кабинет' : 'Начать - 5 расчётов бесплатно'}</a>
      <a class="btn secondary" href="#example">Что входит в расчёт</a>
    </div>
  </div>
  <div class="mock" aria-label="Пример расчёта">
    <div class="head"><span class="mono small muted">Расчёт · пример</span><span class="tag ok" style="margin:0">Выгодно при лучшей цене</span></div>
    <div style="font-size:1.1rem;font-weight:600;margin-top:14px;line-height:1.35">Поставка бумаги для офисной техники</div>
    <div class="small muted" style="margin-top:4px">44-ФЗ · бумага А4</div>
    <div class="stats">
      <div class="stat"><div class="small muted">Начальная цена</div><span class="mono">227 119 ₽</span></div>
      <div class="stat"><div class="small muted">Безубыточно от</div><span class="mono">193 800 ₽</span></div>
    </div>
    <div class="small muted" style="margin-top:18px">Цена за пачку у поставщиков</div>
    <div class="row"><span>Лучшая найденная</span><span class="mono">330 ₽</span></div>
    <div class="row"><span>Худшая найденная</span><span class="mono">384 ₽</span></div>
    <div class="small" style="margin-top:12px;color:var(--navy)">Полный расчёт в Excel</div>
  </div>
</div></section>

<section class="section" id="how"><div class="wrap">
  <div class="eyebrow">Как это работает</div>
  <h2 class="h2">Четыре шага, которые система делает сама</h2>
  <p class="muted" style="margin:8px 0 0">На примере настоящей закупки бумаги А4, расчёт от 07.10.2026.</p>
  <ol class="road">
    <li><span class="n" aria-hidden="true">1</span><h3>Находит тендер</h3><p class="muted">Следит за порталом закупок по вашим словам, цене и стоп-словам.</p>
      <div class="fact"><div class="k">Закупка</div><div>бумага А4, 44-ФЗ</div><div class="k">Начальная цена</div><div class="mono">227 119 ₽</div></div></li>
    <li><span class="n" aria-hidden="true">2</span><h3>Читает документы</h3><p class="muted">ТЗ, спецификация, обоснование цены, сканы и архивы.</p>
      <div class="fact"><div class="k">Позиция</div><div>Бумага А4, 536 пачек</div><div class="k">Характеристики</div><div>из ТЗ заказчика</div></div></li>
    <li><span class="n" aria-hidden="true">3</span><h3>Находит поставщиков</h3><p class="muted">Производители и оптовики с ценами и ссылками. Если загружен ваш прайс, считает по нему.</p>
      <div class="fact"><div class="k">Поставщиков</div><div class="mono">7</div><div class="k">Цена за пачку</div><div class="mono">от 330 до 384 ₽</div></div></li>
    <li><span class="n" aria-hidden="true">4</span><h3>Присылает расчёт</h3><p class="muted">В Telegram и в кабинет: вывод, цифры и файл Excel.</p>
      <div class="fact"><div class="k">Безубыточно от</div><div class="mono">193 800 ₽</div><div class="k">Вывод</div><div>выгодно при лучшей цене: запас 15% от начальной цены</div></div></li>
  </ol>
</div></section>

<section class="section dark" id="example"><div class="wrap">
  <div class="eyebrow">Что вы получаете</div>
  <h2 class="h2">Готовый расчёт по каждой закупке</h2>
  <div class="grid c3" style="margin-top:40px">
    <div class="dcard"><h3>Вывод одной строкой</h3><p class="muted">Выгодно, убыточно или исход зависит от выбора поставщика, с расчётом по каждому варианту.</p></div>
    <div class="dcard"><h3>Цены с источниками</h3><p class="muted">Цена за единицу от и до. У каждой цены источник: строка документа, страница поставщика или ваш прайс.</p></div>
    <div class="dcard"><h3>Сколько нужно денег</h3><p class="muted">Закупка, доставка, обеспечения заявки и контракта, антидемпинговые условия.</p></div>
    <div class="dcard"><h3>Позиции из ТЗ</h3><p class="muted">Наименования, количества и характеристики товара из документации заказчика.</p></div>
    <div class="dcard"><h3>Поставщики</h3><p class="muted">Названия, ссылки и контакты производителей и оптовиков.</p></div>
    <div class="dcard"><h3>Файл Excel с формулами</h3><p class="muted">Любую цифру видно, из чего она сложилась.</p></div>
  </div>
</div></section>

<section class="section"><div class="wrap grid c2" style="align-items:center">
  <div>
    <div class="eyebrow">Как это помогает</div>
    <h2 class="h2">Больше тендеров тем же составом</h2>
    <p class="lead">Вручную на один тендер уходит от двух часов до рабочего дня: документация, позиции, обзвон поставщиков, расчёт. Поэтому смотрят пять тендеров в неделю, а не пятьдесят. Система делает эту работу сама и присылает готовый расчёт. Решение и подача заявки остаются за вами.</p>
  </div>
  <div class="list">
    <div class="card feat">${иконка('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>')}<div><h3 style="margin:0">Время специалиста - на решения</h3><p class="muted" style="margin:4px 0 0">Сбор цифр и поиск поставщиков уходят в систему.</p></div></div>
    <div class="card feat">${иконка('<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>')}<div><h3 style="margin:0">Больше просмотренных тендеров</h3><p class="muted" style="margin:4px 0 0">Без найма новых людей.</p></div></div>
    <div class="card feat">${иконка('<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>')}<div><h3 style="margin:0">Убыточное видно до подачи</h3><p class="muted" style="margin:4px 0 0">Цена, ниже которой контракт в минус, считается всегда.</p></div></div>
  </div>
</div></section>

<section class="section alt" id="features"><div class="wrap">
  <div class="eyebrow">Возможности</div>
  <h2 class="h2">Всё, что нужно для решения по тендеру</h2>
  <div class="grid c3" style="margin-top:40px">
${ВОЗМОЖНОСТИ.map((в) => `    <a class="card tile" href="#${в.ид}">${иконка(в.иконка)}<h3>${esc(в.заголовок)}</h3><p class="muted">${esc(в.кратко)}</p><span class="more">Подробнее</span></a>`).join('\n')}
  </div>
</div></section>
${ВОЗМОЖНОСТИ.map((в) => `<div class="modal" id="${в.ид}" role="dialog" aria-modal="true" aria-labelledby="${в.ид}-h"><a class="modal-bg" href="#features" aria-label="Закрыть"></a>
  <div class="modal-box card"><a class="modal-x" href="#features" aria-label="Закрыть">✕</a>
    <h3 id="${в.ид}-h">${esc(в.заголовок)}</h3>
    <ul>${в.пункты.map((п) => `<li>${esc(п)}</li>`).join('')}</ul>
    ${в.тариф ? `<p class="small muted" style="margin:12px 0 0">${esc(в.тариф)}</p>` : ''}
  </div></div>`).join('\n')}

<section class="section ink" id="security"><div class="wrap grid c2">
  <div>
    <div class="eyebrow">Безопасность</div>
    <h2 class="h2">Ваши цены остаются у вас</h2>
    <p class="lead">Прайс, наценка и стратегия закупок - коммерческая тайна. Система устроена так, чтобы она никуда не уходила.</p>
  </div>
  <div>
    <div class="drow"><h3 style="margin:0">Сервер в России</h3><p class="muted" style="margin:4px 0 0">Данные клиентов хранятся и обрабатываются на российском сервере.</p></div>
    <div class="drow"><h3 style="margin:0">Прайс не передаётся никому</h3><p class="muted" style="margin:4px 0 0">Сопоставление с вашими ценами идёт на нашем сервере, без искусственного интеллекта.</p></div>
    <div class="drow"><h3 style="margin:0">В обработку - только публичное</h3><p class="muted" style="margin:4px 0 0">Искусственный интеллект видит только документацию, опубликованную заказчиком на портале закупок. Контакты из неё вырезаются заранее.</p></div>
    <div class="drow"><h3 style="margin:0">Данные клиентов разделены</h3><p class="muted" style="margin:4px 0 0">Каждый клиент видит только своё. Ничего не подаётся от вашего имени.</p></div>
  </div>
</div></section>

<section class="section" id="plans"><div class="wrap">
  <div class="eyebrow">Тарифы</div>
  <h2 class="h2">Начните с пяти бесплатных расчётов</h2>
  <div class="plans-row" style="margin-top:40px">
    <aside class="setup">
      <div class="eyebrow">Внедрение</div>
      <div class="price">${groupDigits(ВНЕДРЕНИЕ)} ₽<span class="small"> разово</span></div>
      <h3 style="margin:0">Первую неделю работаем параллельно с вами</h3>
${ВНЕДРЕНИЕ_ПУНКТЫ.map((п, i) => `      <div class="drow"><h3 style="margin:0">${i + 1}. ${esc(п.заголовок)}</h3><p class="muted" style="margin:4px 0 0">${esc(п.коротко || п.текст)}</p></div>`).join('\n')}
      <p class="small muted" style="margin:0">Оплачивается один раз, вместе с первым месяцем тарифа.</p>
    </aside>
    <div class="grid c3">
${Object.values(ТАРИФЫ).map((т) => `    <div class="card plan${т.выделен ? ' featured' : ''}"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><h3 style="margin:0">${esc(т.имя)}</h3>${т.метка ? `<span class="badge">${esc(т.метка)}</span>` : ''}</div>
      <div class="price">${groupDigits(т.цена)} ₽<span class="small muted"> / мес</span></div>
      <ul>${т.пункты.map((п) => `<li>${esc(п)}</li>`).join('')}${т.вРазработке.map((п) => `<li class="dev">${esc(п)} - в разработке</li>`).join('')}</ul>
      <a class="btn${т.выделен ? '' : ' secondary'}" href="${пользователь ? `/app/billing#plan-${esc(т.код)}` : начать}">${пользователь ? 'Выбрать' : 'Начать'}</a></div>`).join('\n')}
    </div>
  </div>
  <p class="muted small" style="margin-top:8px">Пробный период - 5 полных расчётов, с поиском поставщиков.${РЕЖИМ.открыто ? '' : ' Сейчас доступ открыт по приглашению.'}</p>
</div></section>

<section class="section alt" id="faq"><div class="wrap" style="max-width:860px">
  <div class="eyebrow">Вопросы</div>
  <h2 class="h2" style="margin-bottom:32px">Частые вопросы</h2>
  <details><summary>Откуда берутся тендеры?</summary><p>С единой информационной системы закупок zakupki.gov.ru: тендеры по 44-ФЗ и 223-ФЗ. Коммерческие площадки - в разработке.</p></details>
  <details><summary>Куда уходят мои данные?</summary><p>Ваш прайс, цены и наценка остаются на нашем сервере в России и никуда не передаются. Для поиска поставщиков в интернете используется только название товара и характеристики из публичного ТЗ закупки.</p></details>
  <details><summary>Откуда цифры в расчёте?</summary><p>Позиции и количества берутся из документации заказчика и сверяются со строкой документа, сумма - с начальной ценой контракта. У каждой цены указан источник со ссылкой.</p></details>
  <details><summary>У меня нет своей базы поставщиков</summary><p>Система ищет поставщиков сама. Если база есть, загрузите прайс, и расчёт пойдёт по вашим ценам.</p></details>
  <details><summary>Подаёт ли система заявки?</summary><p>Нет. Заявку подаёте вы со своей электронной подписью.</p></details>
</div></section>

<section class="section"><div class="wrap" style="text-align:center">
  <h2 class="h2" style="margin:0 auto;max-width:720px">Пять расчётов бесплатно</h2>
  <div class="cta" style="display:flex;gap:12px;justify-content:center;margin-top:28px;flex-wrap:wrap">
    <a class="btn" href="${начать}">${пользователь ? 'Открыть кабинет' : 'Зарегистрироваться'}</a>
    ${пользователь ? '' : '<a class="btn secondary" href="/login">Войти</a>'}
  </div>
</div></section>

<footer class="foot"><div class="wrap" style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap">
  <span>© KarginTech · автоматизация тендеров</span>
  <span style="display:flex;gap:18px;flex-wrap:wrap"><a href="/offer">Оферта</a><a href="/privacy">Политика обработки персональных данных</a><span>kargintech.ru</span></span>
</div></footer>`;
  return страница({ заголовок: 'Тендеры с готовым расчётом', тело, пользователь });
}

/** Кнопка «через Google» - только если владелец вписал ключи. */
// Вид - по правилам Google для кнопки входа: белая, серая рамка, цветной значок «G».
const ЗНАК_GOOGLE = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
const кнопкаГугл = (гугл, надпись) => (гугл ? `<p><a class="gbtn" href="/auth/google">${ЗНАК_GOOGLE}<span>${надпись}</span></a></p><div class="or"><span>или</span></div>` : '');

function вход({ ошибка = '', почта = '', csrf = '', следующая = '', гугл = false } = {}) {
  const тело = `<main class="section"><div class="wrap" style="max-width:440px">
  <div class="card"><h1>Вход</h1>${сообщение('bad', ошибка)}
  ${кнопкаГугл(гугл, 'Войти с аккаунтом Google')}
  <form method="post" action="/login">
    <input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="next" value="${esc(следующая)}">
    <label for="e">Почта</label><input id="e" type="email" name="email" value="${esc(почта)}" autocomplete="username" required>
    <label for="p">Пароль</label><input id="p" type="password" name="password" autocomplete="current-password" required>
    <p class="small" style="margin:8px 0 0"><a href="/forgot">Забыли пароль?</a></p>
    <p style="margin-top:18px"><button class="btn">Войти</button></p>
  </form>
  <p class="small muted">Нет учётной записи? <a href="/register">${РЕЖИМ.открыто ? 'Зарегистрироваться' : 'Регистрация по приглашению'}</a></p></div>
</div></main>`;
  return страница({ заголовок: 'Вход', тело });
}

/** Поле кода приглашения: обязательно при закрытой регистрации, иначе - по желанию. */
const полеКода = (поля, открыто) => (открыто
  ? `<label for="i">Код приглашения <span class="muted" style="font-weight:400">(если есть)</span></label><input id="i" type="text" name="invite" value="${esc(поля.invite || '')}" autocomplete="off">`
  : `<label for="i">Код приглашения</label><input id="i" type="text" name="invite" value="${esc(поля.invite || '')}" autocomplete="off" required>`);

function регистрация({ ошибка = '', поля = {}, csrf = '', гугл = false, открыто = false } = {}) {
  const тело = `<main class="section"><div class="wrap" style="max-width:480px">
  <div class="card"><h1>Регистрация</h1>
  <p class="muted">${открыто ? '5 расчётов бесплатно, без привязки карты.' : 'Сейчас доступ открыт по приглашению. Код приглашения выдаёт KarginTech.'}</p>
  ${сообщение('bad', ошибка)}
  ${кнопкаГугл(гугл, 'Продолжить с аккаунтом Google')}
  <form method="post" action="/register">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    ${полеКода(поля, открыто)}
    <label for="c">Компания</label><input id="c" type="text" name="company" value="${esc(поля.company || '')}" maxlength="120" required>
    <label for="e">Почта</label><input id="e" type="email" name="email" value="${esc(поля.email || '')}" autocomplete="username" required>
    <label for="p">Пароль</label><input id="p" type="password" name="password" autocomplete="new-password" minlength="10" required>
    <div class="hint">Не короче 10 знаков.</div>
    <label class="check"><input type="checkbox" name="consent" value="1" required>
      <span>Принимаю <a href="/offer" target="_blank">оферту</a> и даю согласие на обработку персональных данных по <a href="/privacy" target="_blank">политике</a>. Пароль хранится только в виде необратимого хеша.</span></label>
    <p style="margin-top:18px"><button class="btn">Зарегистрироваться</button></p>
  </form>
  <p class="small muted">Уже есть доступ? <a href="/login">Войти</a></p></div>
</div></main>`;
  return страница({ заголовок: 'Регистрация', тело });
}

function забылиПароль({ ошибка = '', отправлено = false }) {
  const тело = `<main class="section"><div class="wrap" style="max-width:440px"><div class="card">
  <h1>Восстановление пароля</h1>${сообщение('bad', ошибка)}
  ${отправлено
    ? `<div class="alert ok">Если адрес зарегистрирован, на него отправлено письмо со ссылкой для смены пароля. Ссылка действует 1 час. Письмо может попасть в «Спам».</div>
       <p class="small"><a href="/login">Ко входу</a></p>`
    : `<p class="muted">Укажите почту, на которую зарегистрирована учётная запись. Пришлём ссылку для смены пароля.</p>
  <form method="post" action="/forgot">
    <label for="e">Почта</label><input id="e" type="email" name="email" autocomplete="username" required>
    <p style="margin-top:18px"><button class="btn">Отправить ссылку</button></p>
  </form>
  <p class="small muted"><a href="/login">Ко входу</a></p>`}
  </div></div></main>`;
  return страница({ заголовок: 'Восстановление пароля', тело });
}

/** Почта подтверждена Google; остаётся код приглашения и компания. */
function регистрацияGoogle({ почта, ошибка = '', поля = {}, открыто = false }) {
  const тело = `<main class="section"><div class="wrap" style="max-width:480px">
  <div class="card"><h1>Регистрация</h1>
  <p class="muted">Google подтвердил почту <b>${esc(почта)}</b>. Осталось название компании${открыто ? '' : ' и код приглашения'}.</p>
  ${сообщение('bad', ошибка)}
  <form method="post" action="/auth/google/finish">
    ${полеКода(поля, открыто)}
    <label for="c">Компания</label><input id="c" type="text" name="company" value="${esc(поля.company || '')}" maxlength="120" required>
    <label class="check"><input type="checkbox" name="consent" value="1" required>
      <span>Принимаю <a href="/offer" target="_blank">оферту</a> и даю согласие на обработку персональных данных по <a href="/privacy" target="_blank">политике</a>.</span></label>
    <p style="margin-top:18px"><button class="btn">Зарегистрироваться</button></p>
  </form></div>
</div></main>`;
  return страница({ заголовок: 'Регистрация', тело });
}

function сменаПароля({ токен, ошибка = '' }) {
  const тело = `<main class="section"><div class="wrap" style="max-width:440px"><div class="card">
  <h1>Новый пароль</h1>${сообщение('bad', ошибка)}
  <form method="post" action="/reset/${esc(токен)}">
    <label for="p">Новый пароль</label><input id="p" type="password" name="password" autocomplete="new-password" minlength="10" required>
    <div class="hint">Не короче 10 знаков. Ссылка одноразовая.</div>
    <p style="margin-top:18px"><button class="btn">Сохранить</button></p>
  </form></div></div></main>`;
  return страница({ заголовок: 'Новый пароль', тело });
}

function ошибкаСтраницы(код, текст, пользователь = null) {
  return страница({
    заголовок: String(код), пользователь,
    тело: `<main class="section"><div class="wrap" style="max-width:560px"><div class="card"><h1>${esc(код)}</h1><p>${esc(текст)}</p><p><a href="/">На главную</a></p></div></div></main>`
  });
}

module.exports = { РЕЖИМ, главная, вход, регистрация, регистрацияGoogle, забылиПароль, сменаПароля, ошибкаСтраницы };
