/**
 * ВХОД НА САЙТ: пароли, сессии, защита форм, ограничение попыток, второй
 * фактор для кабинета владельца. Только встроенный модуль crypto.
 *
 * Правила, которые нельзя ослаблять:
 *   — пароль хранится необратимым хешем scrypt с солью; сравнение — за
 *     постоянное время (timingSafeEqual), чтобы по времени ответа нельзя было
 *     подбирать хеш;
 *   — сессия — случайные 32 байта, в cookie `__Host-sid` (HttpOnly, Secure,
 *     SameSite=Lax): скрипт страницы её не прочитает, по HTTP она не уйдёт,
 *     чужой сайт не отправит с ней форму;
 *   — у каждой формы скрытый ключ сессии (csrf): форма с чужого сайта его
 *     не знает;
 *   — попытки входа и регистрации ограничены по адресу и по почте;
 *   — кабинет владельца открывается только после кода из приложения-
 *     аутентификатора (TOTP, RFC 6238).
 */
const crypto = require('crypto');

// --- пароли ---------------------------------------------------------------
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function хешПароля(пароль) {
  const соль = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(пароль), соль, 64, SCRYPT);
  return `scrypt$${соль.toString('hex')}$${h.toString('hex')}`;
}

function парольВерен(пароль, запись) {
  const [вид, сольHex, хешHex] = String(запись || '').split('$');
  if (вид !== 'scrypt' || !сольHex || !хешHex) return false;
  const h = crypto.scryptSync(String(пароль), Buffer.from(сольHex, 'hex'), 64, SCRYPT);
  const ждём = Buffer.from(хешHex, 'hex');
  return ждём.length === h.length && crypto.timingSafeEqual(ждём, h);
}

/** Почему пароль не годится, или null. */
function слабыйПароль(пароль, почта = '') {
  const п = String(пароль || '');
  if (п.length < 10) return 'пароль - не короче 10 знаков';
  if (п.length > 200) return 'пароль слишком длинный';
  if (почта && п.toLowerCase() === String(почта).toLowerCase()) return 'пароль не должен совпадать с почтой';
  if (/^(.)\1+$/.test(п) || /^(0123456789|1234567890|qwertyuiop)/i.test(п)) return 'пароль слишком простой';
  return null;
}

function почтаВерна(почта) {
  const п = String(почта || '').trim().toLowerCase();
  return п.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(п) ? п : null;
}

// --- случайные значения ---------------------------------------------------
const случайное = (байт = 32) => crypto.randomBytes(байт).toString('hex');

/** Код приглашения: 12 знаков без похожих букв, удобно продиктовать. */
function кодПриглашения() {
  const алфавит = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const б = crypto.randomBytes(12);
  let s = '';
  for (const x of б) s += алфавит[x % алфавит.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

/** Имя клиента для приложения: site- и 12 случайных знаков. */
const имяКомпании = () => 'site-' + crypto.randomBytes(6).toString('hex');

// --- cookie ---------------------------------------------------------------
const ИМЯ_COOKIE = '__Host-sid';

function разобратьCookie(заголовок) {
  const out = {};
  for (const часть of String(заголовок || '').split(';')) {
    const i = часть.indexOf('=');
    if (i < 0) continue;
    out[часть.slice(0, i).trim()] = decodeURIComponent(часть.slice(i + 1).trim());
  }
  return out;
}

function cookieСессии(ид, секунд) {
  return `${ИМЯ_COOKIE}=${ид}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${секунд}`;
}
const cookieВыхода = () => `${ИМЯ_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

// --- сроки сессий ---------------------------------------------------------
/** Простой без действий: клиент - 3 дня, владелец - 1 час. */
const ПРОСТОЙ_КЛИЕНТ_МС = 3 * 24 * 3600 * 1000;
const ПРОСТОЙ_ВЛАДЕЛЕЦ_МС = 3600 * 1000;
/** Сессия вообще: 30 дней. */
const ЖИЗНЬ_СЕССИИ_МС = 30 * 24 * 3600 * 1000;

function сессияЖива(с, роль, now = Date.now()) {
  if (!с) return false;
  const простой = роль === 'owner' ? ПРОСТОЙ_ВЛАДЕЛЕЦ_МС : ПРОСТОЙ_КЛИЕНТ_МС;
  return now - Date.parse(с.seen) < простой && now - Date.parse(с.created) < ЖИЗНЬ_СЕССИИ_МС;
}

// --- ограничение попыток --------------------------------------------------
/**
 * Окно попыток в памяти процесса. При перезапуске сбрасывается - это
 * допустимо: перебору нужны тысячи попыток, а перезапуск их не даёт.
 */
function ограничитель(сколько, окноМс) {
  const м = new Map();
  return {
    можно(ключ, now = Date.now()) {
      const з = (м.get(ключ) || []).filter((t) => now - t < окноМс);
      м.set(ключ, з);
      return з.length < сколько;
    },
    учесть(ключ, now = Date.now()) {
      const з = (м.get(ключ) || []).filter((t) => now - t < окноМс);
      з.push(now);
      м.set(ключ, з);
      if (м.size > 50000) м.clear();
    },
    сброс(ключ) { м.delete(ключ); }
  };
}

// --- TOTP (RFC 6238) ------------------------------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(буфер) {
  let биты = 0, значение = 0, out = '';
  for (const b of буфер) {
    значение = (значение << 8) | b;
    биты += 8;
    while (биты >= 5) { out += B32[(значение >>> (биты - 5)) & 31]; биты -= 5; }
  }
  if (биты > 0) out += B32[(значение << (5 - биты)) & 31];
  return out;
}

function изBase32(s) {
  const чисто = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let биты = 0, значение = 0;
  const out = [];
  for (const ch of чисто) {
    значение = (значение << 5) | B32.indexOf(ch);
    биты += 5;
    if (биты >= 8) { out.push((значение >>> (биты - 8)) & 255); биты -= 8; }
  }
  return Buffer.from(out);
}

const новыйСекретTotp = () => base32(crypto.randomBytes(20));

function кодTotp(секрет, шаг) {
  const сч = Buffer.alloc(8);
  сч.writeBigUInt64BE(BigInt(шаг));
  const h = crypto.createHmac('sha1', изBase32(секрет)).update(сч).digest();
  const o = h[h.length - 1] & 15;
  const ч = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(ч % 1000000).padStart(6, '0');
}

/** Код верен в окне ±1 шаг (30 с) - на расхождение часов телефона и сервера. */
function totpВерен(секрет, код, now = Date.now()) {
  const к = String(код || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(к) || !секрет) return false;
  const шаг = Math.floor(now / 30000);
  for (const d of [-1, 0, 1]) {
    const ждём = Buffer.from(кодTotp(секрет, шаг + d));
    if (crypto.timingSafeEqual(ждём, Buffer.from(к))) return true;
  }
  return false;
}

const адресTotp = (секрет, почта) =>
  `otpauth://totp/KarginTech:${encodeURIComponent(почта)}?secret=${секрет}&issuer=KarginTech&digits=6&period=30`;

/** Сравнение ключа формы за постоянное время. */
function csrfВерен(ждём, пришло) {
  const a = Buffer.from(String(ждём || ''));
  const b = Buffer.from(String(пришло || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Хеш ссылки сброса: в базе хранится он, а не сама ссылка. */
const хешСсылки = (токен) => crypto.createHash('sha256').update(String(токен)).digest('hex');

module.exports = {
  хешСсылки,
  хешПароля, парольВерен, слабыйПароль, почтаВерна, случайное, кодПриглашения, имяКомпании,
  ИМЯ_COOKIE, разобратьCookie, cookieСессии, cookieВыхода, сессияЖива, ЖИЗНЬ_СЕССИИ_МС,
  ограничитель, новыйСекретTotp, кодTotp, totpВерен, адресTotp, csrfВерен, base32, изBase32
};
