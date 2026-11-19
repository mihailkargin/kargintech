/**
 * Команды владельца для сайта — запускаются на сервере:
 *
 *   docker compose exec site node site/admin.js invite "кому"
 *       напечатать новый код приглашения (одноразовый);
 *   docker compose exec site node site/admin.js make-owner почта@пример.ru
 *       сделать зарегистрированного пользователя владельцем и выдать секрет
 *       для приложения-аутентификатора (Google Authenticator, Яндекс Ключ);
 *   docker compose exec site node site/admin.js users
 *       список пользователей.
 *
 * Пароль здесь не задаётся и не печатается никогда: владелец регистрируется
 * на сайте сам, по коду приглашения, как любой клиент.
 */
const { открыть } = require('./db');
const А = require('./auth');

const db = открыть(process.env.SITE_DB || '/data/site.db');
const [команда, арг] = process.argv.slice(2);

if (команда === 'invite') {
  const код = А.кодПриглашения();
  db.создатьПриглашение(код, String(арг || '').slice(0, 120));
  db.журнал('приглашение из командной строки', String(арг || ''));
  console.log(`Код приглашения: ${код}`);
  console.log('Регистрация: https://kargintech.ru/register');
} else if (команда === 'make-owner') {
  const у = db.пользовательПоПочте(String(арг || '').trim().toLowerCase());
  if (!у) { console.log('Такого пользователя нет. Сначала зарегистрируйтесь на сайте по коду приглашения.'); process.exit(1); }
  const секрет = А.новыйСекретTotp();
  db.задатьРоль(у.id, 'owner');
  db.задатьTotp(у.id, секрет);
  db.удалитьСессииПользователя(у.id);
  db.журнал('назначен владелец', у.email, у.company_id, у.id);
  console.log('Готово. Добавьте в приложение-аутентификатор запись вручную:');
  console.log(`  ключ: ${секрет}`);
  console.log('  тип: по времени, 6 цифр, 30 секунд');
  console.log(`или ссылкой: ${А.адресTotp(секрет, у.email)}`);
  console.log('Ключ больше нигде не печатается. Все сессии этого пользователя закрыты — войдите заново.');
} else if (команда === 'users') {
  for (const у of db.пользователи()) console.log(`${у.id}\t${у.email}\t${у.role}\t${у.name}\t${у.slug}`);
} else if (команда === 'delete-company') {
  // Удаление по запросу клиента (политика ПДн, раздел 7). НЕОБРАТИМО, поэтому
  // без --yes только показывает, что будет удалено. Платежи остаются: их
  // требует налоговый учёт; у них остаётся только номер компании.
  const к = db.сырая.prepare('SELECT * FROM companies WHERE slug = ?').get(String(арг || ''));
  if (!к) { console.log('Такой компании нет. Имя - как в списке users, вида site-…'); process.exit(1); }
  const у = db.сырая.prepare('SELECT id, email, role FROM users WHERE company_id = ?').all(к.id);
  if (у.some((x) => x.role === 'owner')) { console.log('Это компания владельца сайта - не удаляется.'); process.exit(1); }
  console.log(`Компания «${к.name}» (${к.slug}), пользователи: ${у.map((x) => x.email).join(', ') || 'нет'}`);
  if (process.argv[4] !== '--yes') {
    console.log('Будут удалены: пользователи, входы, настройки, отметки, расчёты и файлы Excel, поиски, наборы фильтров, пометки поставщиков, Telegram, записи журнала этой компании.');
    console.log('Платежи останутся (налоговый учёт). Чтобы удалить, повторите команду с --yes в конце.');
    process.exit(0);
  }
  const d = db.сырая;
  const ид = у.map((x) => x.id);
  d.exec('BEGIN IMMEDIATE');
  try {
    for (const п of ид) {
      for (const т of ['sessions', 'password_resets', 'tg_codes']) d.prepare(`DELETE FROM ${т} WHERE user_id = ?`).run(п);
      const ч = d.prepare('SELECT chat_id FROM tg_chats WHERE user_id = ?').get(п);
      if (ч) d.prepare('DELETE FROM outbox WHERE chat_id = ?').run(ч.chat_id);
      d.prepare('DELETE FROM tg_chats WHERE user_id = ?').run(п);
      d.prepare('UPDATE invites SET used_by = NULL WHERE used_by = ?').run(п);
    }
    for (const т of ['settings', 'tender_marks', 'calcs', 'searches', 'filter_sets', 'supplier_marks', 'best_plans', 'log']) d.prepare(`DELETE FROM ${т} WHERE company_id = ?`).run(к.id);
    d.prepare('DELETE FROM log WHERE user_id IN (' + (ид.length ? ид.map(() => '?').join(',') : 'NULL') + ')').run(...ид);
    d.prepare('DELETE FROM users WHERE company_id = ?').run(к.id);
    d.prepare("UPDATE companies SET name = '[удалена]', onboarded = 0, tariff = '', paid_until = NULL WHERE id = ?").run(к.id);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    console.log('Не удалено, ничего не изменилось: ' + e.message);
    process.exit(1);
  }
  db.журнал('компания удалена по запросу', к.slug);
  console.log('Удалено из базы сайта. Осталось удалить файлы приложения этой компании:');
  console.log(`  docker compose exec app sh -c 'cd /data && ls clients/${к.slug}* state/${к.slug}* 2>/dev/null'`);
  console.log('  (посмотреть) и затем удалить показанные файлы. Резервные копии со старыми данными уходят сами по мере обновления.');
} else {
  console.log('Команды: invite "кому" | make-owner почта | users | delete-company site-… [--yes]');
  process.exit(1);
}
