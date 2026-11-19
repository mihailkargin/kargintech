/**
 * КАБИНЕТ ВЛАДЕЛЬЦА: клиенты, регистрации, приглашения, сбои, журнал.
 * Открывается только после кода из приложения-аутентификатора.
 * Клиент сбоев не видит — их видит владелец здесь.
 */
const { esc, дата, страница, сообщение } = require('./views');

function кодTotp({ пользователь, ошибка = '' }) {
  const тело = `<main class="section"><div class="wrap" style="max-width:420px"><div class="card">
  <h1>Код подтверждения</h1><p class="muted">Введите шесть цифр из приложения-аутентификатора (запись KarginTech).</p>
  ${сообщение('bad', ошибка)}
  <form method="post" action="/owner/totp"><input type="hidden" name="csrf" value="${esc(пользователь.csrf)}">
    <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
    <p style="margin-top:14px"><button class="btn">Подтвердить</button></p></form></div></div></main>`;
  return страница({ заголовок: 'Код подтверждения', тело, пользователь });
}

function владелец({ пользователь, компании, пользователи, приглашения, сбои, журнал, поиски, новыйКод = '', ссылкаСброса = '', платежи = [], оплатаПодключена = false }) {
  const { ТАРИФЫ } = require('./tariffs');
  const { деньги } = require('./views');
  const тарифКомпании = (к) => {
    const т = ТАРИФЫ[к.tariff];
    const активен = т && Date.parse(к.paid_until) > Date.now();
    return т ? `${esc(т.имя)} ${активен ? 'до' : 'истёк'} ${esc(дата(к.paid_until))}` : 'пробный';
  };
  const скр = `<input type="hidden" name="csrf" value="${esc(пользователь.csrf)}">`;
  const таблица = (заголовки, строки) => строки.length
    ? `<div class="scroll"><table class="t"><tr>${заголовки.map((з) => `<th>${з}</th>`).join('')}</tr>${строки.join('')}</table></div>`
    : '<p class="muted">Пусто.</p>';
  const тело = `<main class="section"><div class="wrap stack">
  <h1>Кабинет владельца</h1>
  ${новыйКод ? `<div class="alert ok">Новый код приглашения: <b>${esc(новыйКод)}</b> — передайте его тестеру. Код одноразовый.</div>` : ''}
  ${ссылкаСброса ? `<div class="alert ok">Ссылка для смены пароля (одноразовая, действует сутки, больше не показывается): <b>${esc(ссылкаСброса)}</b></div>` : ''}
  <div class="card"><h2>Приглашения</h2>
    <form method="post" action="/owner/invite" class="grid c2">${скр}<input type="text" name="note" maxlength="120" placeholder="Кому (заметка для себя)"><button class="btn small">Создать код</button></form>
    ${таблица(['Код', 'Кому', 'Создан', 'Использован'], приглашения.map((и) =>
      `<tr><td class="nowrap">${esc(и.code)}</td><td>${esc(и.note)}</td><td>${esc(дата(и.created))}</td><td>${и.used_at ? esc(дата(и.used_at)) : '—'}</td></tr>`))}
  </div>
  <div class="card"><h2>Клиенты</h2>
    ${таблица(['Компания', 'Имя в системе', 'Тариф', 'Расчёты (пробные)', 'Расход на модель', 'Последний поиск', 'Лимит пробных', 'Тариф вручную'], компании.map((к) => {
      const п = поиски[к.id];
      const оп = (з, т) => `<option value="${з}"${к.tariff === з ? ' selected' : ''}>${т}</option>`;
      const вручную = `<form method="post" action="/owner/company/${esc(к.id)}/tariff" class="inline">${скр}<select name="tariff" style="width:auto">${оп('', 'без тарифа')}${Object.values(ТАРИФЫ).map((т) => оп(т.код, т.имя)).join('')}</select>
        <input type="number" name="days" min="0" max="400" value="30" style="width:70px" title="дней"> <button class="btn small secondary">OK</button></form>`;
      return `<tr><td>${esc(к.name)}</td><td class="nowrap">${esc(к.slug)}</td><td class="nowrap">${тарифКомпании(к)}</td><td>${esc(к.calcs_used)} из ${esc(к.calcs_limit)}</td>
      <td class="nowrap">$${esc(Number(к.cost_month || 0).toFixed(2))} в месяце · $${esc(Number(к.cost_total || 0).toFixed(2))} всего</td>
      <td>${п ? `${esc(п.status)} · ${esc(дата(п.finished || п.created))}` : 'не было'}</td>
      <td><form method="post" action="/owner/company/${esc(к.id)}/limit" class="inline">${скр}<input type="number" name="limit" min="0" max="1000" value="${esc(к.calcs_limit)}" style="width:80px"> <button class="btn small secondary">OK</button></form></td><td>${вручную}</td></tr>`;
    }))}
    <p class="small muted">Тариф вручную - для оплаты по счёту. При том же тарифе дни добавляются к концу срока, при другом - отсчёт от сегодня. «Без тарифа» снимает тариф.</p>
  </div>
  <div class="card"><h2>Платежи</h2>
    <p class="small muted">${оплатаПодключена ? 'Оплата через ЮKassa подключена.' : 'Оплата через ЮKassa не подключена: нет ключей YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY в .env.'}</p>
    ${таблица(['Когда', 'Компания', 'Тариф', 'Сумма', 'Статус', 'Номер ЮKassa'], платежи.map((п) =>
      `<tr><td class="nowrap">${esc(дата(п.created))}</td><td>${esc(п.name)}</td><td>${esc((ТАРИФЫ[п.tariff] || {}).имя || п.tariff)}</td><td class="nowrap">${деньги(п.amount)}</td><td>${esc(п.status)}</td><td class="small">${esc(п.yk_id || '')}</td></tr>`))}
  </div>
  <div class="card"><h2>Пользователи</h2>
    ${таблица(['Почта', 'Компания', 'Роль', 'Зарегистрирован', 'Последний вход', ''], пользователи.map((у) =>
      `<tr><td>${esc(у.email)}</td><td>${esc(у.name)}</td><td>${esc(у.role)}</td><td>${esc(дата(у.created))}</td><td>${у.last_login ? esc(дата(у.last_login)) : '—'}</td>
      <td><form method="post" action="/owner/user/${esc(у.id)}/reset" class="inline">${скр}<button class="btn small secondary">Ссылка для смены пароля</button></form></td></tr>`))}
  </div>
  <div class="card"><h2>Сбои расчётов</h2>
    ${таблица(['Когда', 'Клиент', 'Закупка', 'Причина'], сбои.map((с) =>
      `<tr><td class="nowrap">${esc(дата(с.created))}</td><td>${esc(с.slug)}</td><td>${esc(с.number)}</td><td>${esc(с.error || '')}</td></tr>`))}
  </div>
  <div class="card"><h2>Журнал</h2>
    ${таблица(['Когда', 'Действие', 'Подробно'], журнал.map((з) =>
      `<tr><td class="nowrap small">${esc(String(з.at).replace('T', ' ').slice(0, 19))}</td><td>${esc(з.action)}</td><td class="small">${esc(з.detail)}</td></tr>`))}
  </div>
</div></main>`;
  return страница({ заголовок: 'Кабинет владельца', тело, пользователь });
}

module.exports = { кодTotp, владелец };
