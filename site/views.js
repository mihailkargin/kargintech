/**
 * СТРАНИЦЫ САЙТА — HTML строками, без шаблонизатора и без сторонних библиотек.
 *
 * ПРАВИЛО: всё, что пришло извне (от клиента, с портала, из расчёта),
 * выводится через esc(). Исключение одно — подпись расчёта: она приходит с
 * разметкой для Telegram, и из неё пропускаются только безопасные теги
 * (`безопаснаяПодпись`). Скриптов на страницах нет, кроме /static/app.js:
 * заголовок CSP запрещает встроенные скрипты вовсе.
 */
const { groupDigits } = require('../src/notify');
const fs = require('fs');
const path = require('path');

/**
 * Версия оформления в адресе файла стилей. Найдено 21.10.2026: после выкатки
 * браузер владельца час показывал новые страницы со СТАРЫМ site.css из своего
 * запаса - оранжевые кнопки, шаги текстом. Адрес с отпечатком содержимого
 * меняется при каждой правке, и браузер берёт новый файл сразу.
 */
const версия = (имя) => {
  try { return require('crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'static', имя))).digest('hex').slice(0, 10); } catch (e) { return '0'; }
};
const ВЕРСИЯ_CSS = версия('site.css');
const ВЕРСИЯ_JS = версия('app.js');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Сумма с отступами на тысячах и копейками через запятую (решение владельца
// 15.11: «не 1000000, а 1 000 000»). Целые суммы печатаются без копеек.
const деньги = (n) => {
  if (typeof n !== 'number' || !isFinite(n)) return 'не определено';
  const знак = n < 0 ? '-' : '';
  const абс = Math.abs(Math.round(n * 100) / 100);
  const целое = Math.floor(абс);
  const дробь = Math.round((абс - целое) * 100);
  if (!дробь) return `${знак}${groupDigits(целое)} ₽`;
  return `${знак}${groupDigits(целое)},${String(дробь).padStart(2, '0')} ₽`;
};

function дата(s) {
  if (!s) return 'не указан';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : esc(s);
}

/** Сколько дней до срока (по дате), или null. */
function днейДо(s, now = new Date()) {
  if (!s) return null;
  const d = Date.parse(String(s).slice(0, 10) + 'T23:59:59');
  if (isNaN(d)) return null;
  return Math.floor((d - now.getTime()) / 86400000);
}

function срокМетка(s) {
  const д = днейДо(s);
  if (д === null) return '<span class="tag">срок не указан</span>';
  if (д < 0) return '<span class="tag">подача завершена</span>';
  if (д < 2) return `<span class="tag hot">осталось ${д === 0 ? 'меньше суток' : '1 день'}</span>`;
  if (д <= 3) return `<span class="tag warn">осталось ${д} дн.</span>`;
  return `<span class="tag">осталось ${д} дн.</span>`;
}

/**
 * Подпись расчёта из приложения - HTML для Telegram (b, i, blockquote, a).
 * Всё экранируется, затем возвращаются только эти теги; ссылка - только
 * https и без кавычек внутри.
 */
function безопаснаяПодпись(html) {
  let s = esc(html);
  s = s.replace(/&lt;(\/?)(b|i|u|code)&gt;/g, '<$1$2>');
  s = s.replace(/&lt;blockquote(?: expandable)?&gt;/g, '<blockquote>').replace(/&lt;\/blockquote&gt;/g, '</blockquote>');
  s = s.replace(/&lt;a href=&quot;(https:\/\/[^"&<>\s]+?)&quot;&gt;([\s\S]*?)&lt;\/a&gt;/g,
    (_, u, t) => `<a href="${u}" rel="noopener noreferrer" target="_blank">${t}</a>`);
  return s;
}

function шапка(пользователь) {
  const nav = пользователь
    ? `<a href="/app">Кабинет</a>${пользователь.role === 'owner' ? '<a href="/owner">Владелец</a>' : ''}
       <form class="inline" method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(пользователь.csrf)}"><button class="btn link" style="color:#4a5568">Выйти</button></form>`
    : '<a class="hide-m" href="/#how">Как работает</a><a class="hide-m" href="/#security">Безопасность</a><a class="hide-m" href="/#plans">Тарифы</a><a class="btn secondary small" href="/login">Войти</a><a class="btn small" href="/register">Начать</a>';
  return `<header class="top"><div class="wrap"><a class="logo" href="/">KarginTech<span class="dot" aria-hidden="true">.</span></a><nav>${nav}</nav></div></header>`;
}

function страница({ заголовок, тело, пользователь = null, описание = '', безИндекса = false, классТела = '' }) {
  return `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${безИндекса ? '\n<meta name="robots" content="noindex">' : ''}
<title>${esc(заголовок)} · KarginTech</title>
<meta name="description" content="${esc(описание || 'Автоматизация тендеров: поиск закупок, разбор документации, закупочные цены у поставщиков, готовый расчёт.')}">
<link rel="stylesheet" href="/static/site.css?v=${ВЕРСИЯ_CSS}">
<link rel="icon" href="data:,">
</head><body${классТела ? ` class="${классТела}"` : ''}>
${шапка(пользователь)}
${тело}
<script src="/static/app.js?v=${ВЕРСИЯ_JS}" defer></script>
</body></html>`;
}

/** Иконки меню - линиями, как в макете бизнес-сессии. */
const ИКОНКИ = {
  лента: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  история: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  поставщики: '<path d="M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6"/>',
  прайс: '<path d="M4 4h16v16H4z"/><path d="M4 9h16M9 9v11"/>',
  настройки: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  тариф: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  профиль: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'
};
const иконкаМеню = (к) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ИКОНКИ[к] || ''}</svg>`;

function меню(активный) {
  const пункты = [['/app', 'Тендеры', 'лента'], ['/app/upload', 'По документам', 'загрузка'], ['/app/history', 'История', 'история'], ['/app/suppliers', 'Поставщики', 'поставщики'], ['/app/niche', 'Аналитика ниши', 'ниша'], ['/app/price', 'Мой прайс', 'прайс'], ['/app/settings', 'Настройки', 'настройки'], ['/app/billing', 'Тариф', 'тариф'], ['/app/profile', 'Профиль', 'профиль']];
  return `<aside class="side"><nav>${пункты.map(([h, t, к]) =>
    `<a href="${h}" class="${к === активный ? 'on' : ''}">${иконкаМеню(к)}${t}</a>`).join('')}</nav></aside>`;
}

function кабинет({ заголовок, тело, пользователь, активный }) {
  return страница({
    заголовок, пользователь, классТела: 'in-app',
    тело: `<div class="app">${меню(активный)}<main class="main"><div class="wrap">${тело}</div></main></div>`
  });
}

const сообщение = (вид, текст) => (текст ? `<div class="alert ${вид}">${esc(текст)}</div>` : '');

module.exports = { esc, деньги, дата, днейДо, срокМетка, безопаснаяПодпись, страница, кабинет, сообщение };
