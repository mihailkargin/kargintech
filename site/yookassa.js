/**
 * ЮKASSA — приём оплаты тарифа. 21.10.2026, без сторонних библиотек.
 *
 * Ключи магазина владелец вводит сам в .env на сервере: YOOKASSA_SHOP_ID и
 * YOOKASSA_SECRET_KEY. Без них оплата на сайте выключена и это сказано
 * клиенту словами, а не ошибкой.
 *
 * ГЛАВНОЕ ПРАВИЛО: уведомлению об оплате не верим. Его может прислать кто
 * угодно - адрес открыт в интернет. Из уведомления берётся только номер
 * платежа, а статус и сумма запрашиваются у самой ЮKassa по нашим ключам.
 * Так советует и документация ЮKassa.
 */
const https = require('https');

const API = 'api.yookassa.ru';

function запрос(метод, путь, тело, ключи, ключПовтора, мс = 20000) {
  return new Promise((ok) => {
    const данные = тело ? Buffer.from(JSON.stringify(тело)) : null;
    const заг = {
      Authorization: 'Basic ' + Buffer.from(`${ключи.shopId}:${ключи.secret}`).toString('base64'),
      Accept: 'application/json'
    };
    if (данные) { заг['Content-Type'] = 'application/json'; заг['Content-Length'] = данные.length; }
    if (ключПовтора) заг['Idempotence-Key'] = ключПовтора;
    const req = https.request({ hostname: API, path: путь, method: метод, headers: заг, timeout: мс }, (res) => {
      const куски = [];
      res.on('data', (c) => куски.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(куски).toString('utf8')); } catch (e) { /* не JSON */ }
        if (res.statusCode >= 200 && res.statusCode < 300 && j) ok({ ok: true, платёж: j });
        else ok({ ok: false, сбой: `ЮKassa ответила ${res.statusCode}${j && j.description ? `: ${j.description}` : ''}` });
      });
    });
    req.on('timeout', () => req.destroy(new Error('ЮKassa не ответила')));
    req.on('error', (e) => ok({ ok: false, сбой: e.message }));
    req.end(данные || undefined);
  });
}

function ключиИзОкружения(env = process.env) {
  const shopId = String(env.YOOKASSA_SHOP_ID || '').trim();
  const secret = String(env.YOOKASSA_SECRET_KEY || '').trim();
  return shopId && secret ? { shopId, secret } : null;
}

/** Клиент ЮKassa: создать платёж и узнать его состояние. */
function клиент(ключи) {
  return {
    подключена: !!ключи,
    создать({ сумма, описание, возврат, метаданные, ключПовтора }) {
      if (!ключи) return Promise.resolve({ ok: false, сбой: 'оплата не подключена' });
      return запрос('POST', '/v3/payments', {
        amount: { value: Number(сумма).toFixed(2), currency: 'RUB' },
        capture: true,
        confirmation: { type: 'redirect', return_url: возврат },
        description: String(описание).slice(0, 128),
        metadata: метаданные
      }, ключи, ключПовтора);
    },
    получить(id) {
      if (!ключи) return Promise.resolve({ ok: false, сбой: 'оплата не подключена' });
      if (!/^[0-9a-f-]{20,60}$/i.test(String(id))) return Promise.resolve({ ok: false, сбой: 'номер платежа не похож на номер ЮKassa' });
      return запрос('GET', `/v3/payments/${id}`, null, ключи);
    }
  };
}

/** Ссылка на оплату - только на страницы ЮKassa/ЮMoney: чужой адрес клиенту не показываем. */
const ссылкаОплатыВерна = (u) => /^https:\/\/([a-z0-9-]+\.)*(yoomoney\.ru|yookassa\.ru)\//i.test(String(u || ''));

module.exports = { клиент, ключиИзОкружения, ссылкаОплатыВерна };
