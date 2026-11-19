/**
 * ВХОД ЧЕРЕЗ GOOGLE — 21.10.2026, без сторонних библиотек (OAuth 2.0, OpenID).
 *
 * Ключи GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET владелец берёт в Google Cloud
 * Console и вписывает в .env сам. Без них кнопки «Войти через Google» нет.
 *
 * Подпись токена не проверяем: id_token получен НАПРЯМУЮ от Google по HTTPS
 * в обмен на код и наш секрет - так прямо разрешает документация Google.
 * Проверяем выдавшего, адресата (наш client_id), срок и подтверждённую почту.
 */
const https = require('https');

const АДРЕС_ВХОДА = 'https://accounts.google.com/o/oauth2/v2/auth';

function ключиИзОкружения(env = process.env) {
  // При копировании из консоли Google к ID прилипает «https://» (22.10.2026,
  // ошибка 401 invalid_client) - отбрасываем адресные хвосты.
  const id = String(env.GOOGLE_CLIENT_ID || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const секрет = String(env.GOOGLE_CLIENT_SECRET || '').trim();
  return id && секрет ? { id, секрет } : null;
}

function адресВхода(ключи, возврат, state) {
  const u = new URL(АДРЕС_ВХОДА);
  u.searchParams.set('client_id', ключи.id);
  u.searchParams.set('redirect_uri', возврат);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email');
  u.searchParams.set('state', state);
  u.searchParams.set('prompt', 'select_account');
  return u.toString();
}

function запросТокена(тело, мс = 20000) {
  return new Promise((ok) => {
    const данные = Buffer.from(new URLSearchParams(тело).toString());
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', timeout: мс,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': данные.length }
    }, (res) => {
      const к = [];
      res.on('data', (c) => к.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(к).toString('utf8')); } catch (e) { /* не JSON */ }
        ok(res.statusCode === 200 && j && j.id_token ? { ok: true, idToken: j.id_token } : { ok: false, сбой: `Google ответил ${res.statusCode}${j && j.error ? `: ${j.error}` : ''}` });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Google не ответил')));
    req.on('error', (e) => ok({ ok: false, сбой: e.message }));
    req.end(данные);
  });
}

/** Содержимое id_token и его проверка. */
function разобратьТокен(idToken, ключи, now = Date.now()) {
  const части = String(idToken || '').split('.');
  if (части.length !== 3) return { ok: false, сбой: 'токен не похож на id_token' };
  let п;
  try { п = JSON.parse(Buffer.from(части[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch (e) { return { ok: false, сбой: 'токен не разобран' }; }
  if (п.iss !== 'https://accounts.google.com' && п.iss !== 'accounts.google.com') return { ok: false, сбой: 'токен выдан не Google' };
  if (п.aud !== ключи.id) return { ok: false, сбой: 'токен выдан не для нашего сайта' };
  if (!(Number(п.exp) * 1000 > now)) return { ok: false, сбой: 'срок токена истёк' };
  if (п.email_verified !== true && п.email_verified !== 'true') return { ok: false, сбой: 'почта в Google не подтверждена' };
  const почта = String(п.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(почта)) return { ok: false, сбой: 'в токене нет почты' };
  return { ok: true, почта };
}

/** Обмен кода на почту. обмен - подменяется в проверках. */
async function почтаПоКоду(ключи, код, возврат, обмен = запросТокена) {
  if (!/^[\w./-]{10,512}$/.test(String(код || ''))) return { ok: false, сбой: 'нет кода от Google' };
  const т = await обмен({ code: код, client_id: ключи.id, client_secret: ключи.секрет, redirect_uri: возврат, grant_type: 'authorization_code' });
  if (!т.ok) return т;
  return разобратьТокен(т.idToken, ключи);
}

module.exports = { ключиИзОкружения, адресВхода, почтаПоКоду, разобратьТокен };
