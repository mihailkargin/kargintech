/**
 * СТРАНИЦЫ ЛИЧНОГО КАБИНЕТА: стартовый вопрос, лента, карточка тендера,
 * расчёт, история, настройки. Данные приходят уже отобранными по компании
 * пользователя (site/server.js) — здесь только вывод.
 *
 * Правило проекта: неизвестное пишется словами («не определено»), нулём
 * никогда.
 */
const { esc, деньги, дата, днейДо, срокМетка, безопаснаяПодпись, кабинет, сообщение } = require('./views');

const { СПИСОК_РЕГИОНОВ, названиеРегиона, близость, округРегиона } = require('../src/region');
const { normalize, основа, естьОснова } = require('../src/filter');
const { видЗакупки: видПредмета } = require('../src/item-kind');
const { КАТЕГОРИИ, разобратьСтоп, кодыКатегорий } = require('./categories');

/** Категории двумя разделами: товары, работы и услуги. */
function сеткаКатегорий(выбрано) {
  const плитка = (к) => `<label class="cat"><input type="checkbox" name="cat" value="${esc(к.ид)}"${выбрано.has(к.ид) ? ' checked' : ''}><span>${esc(к.имя)}</span></label>`;
  return `<h3 class="cat-h">Товары</h3><div class="cat-grid">${КАТЕГОРИИ.filter((к) => !к.услуги).map(плитка).join('')}</div>
    <h3 class="cat-h">Работы и услуги</h3><div class="cat-grid">${КАТЕГОРИИ.filter((к) => к.услуги).map(плитка).join('')}</div>`;
}
/** Итог проверки слов: по каждой фразе - сколько закупок отдал портал и сколько попадёт в ленту. */
function блокПроверки(п) {
  if (!п) return '';
  if (!п.ok) return сообщение('bad', `Проверка не выполнена: ${п.сбой || 'портал не ответил'}. Повторите позже.`);
  const строки = (п.слова || []).map((с) => `<tr><td>${esc(с.слово)}</td><td class="mono">${esc(с.всего ?? '—')}</td><td class="mono">${esc(с.портал)}</td><td class="mono">${esc(с.прошло)}</td></tr>`).join('');
  const пусто = (п.слова || []).filter((с) => с.прошло === 0);
  return `<div class="card stack" style="max-width:900px;margin-bottom:16px"><h2 style="margin:0">Проверка: ${esc(п.всего)} действующих закупок</h2>
    <div class="scroll"><table class="t"><tr><th>Ключевое слово</th><th>Всего на портале</th><th>Проверено</th><th>Попадёт в ленту</th></tr>${строки}</table></div>
    ${пусто.length ? `<p class="small" style="margin:0">По словам ${пусто.map((с) => `«${esc(с.слово)}»`).join(', ')} в ленту не попадёт ничего. Измените формулировку: как в названиях закупок, например «уборка помещений» вместо «промышленный клининг».</p>` : ''}
    ${п.примеры && п.примеры.length ? `<div class="small muted">Примеры: ${п.примеры.map((x) => esc(x)).join(' · ')}</div>` : ''}
    <p class="small muted" style="margin:0">Для проверки взяты первые 50 закупок по каждому слову; ежедневный поиск берёт до 100. Настройки ещё не сохранены.</p></div>`;
}

const скрытое = (csrf) => `<input type="hidden" name="csrf" value="${esc(csrf)}">`;

function онбординг({ пользователь, категории = [], слова = '', ошибка = '' }) {
  const выбрано = new Set(категории);
  const тело = `<div class="card stack" style="max-width:860px">
  <h1>Товарные категории</h1>
  <p class="muted">Выберите категории, по которым вы участвуете в закупках. Лента сформируется по ним, состав можно изменить в настройках.</p>
  ${сообщение('bad', ошибка)}
  <form method="post" action="/app/onboarding">${скрытое(пользователь.csrf)}
    ${сеткаКатегорий(выбрано)}
    <label for="w">Дополнительные ключевые слова</label>
    <textarea id="w" name="words" rows="3" placeholder="например: кабель силовой ВВГнг&#10;розетки накладные">${esc(слова)}</textarea>
    <div class="hint">Необязательно. По одному слову или словосочетанию на строку.</div>
    <label class="check" style="margin-top:12px"><input type="checkbox" name="services" value="1"><span>Показывать закупки работ и услуг: монтаж, обслуживание, ремонт, аренда</span></label>
    <p style="margin-top:18px"><button class="btn">Сформировать ленту</button> <a class="btn secondary" href="/app">Пропустить</a></p>
  </form>
</div>`;
  return кабинет({ заголовок: 'Товарные категории', тело, пользователь, активный: 'лента' });
}

const СПОСОБЫ = [['аукцион', /аукцион/i, 'Аукцион'], ['котировки', /котиров/i, 'Запрос котировок'], ['конкурс', /конкурс/i, 'Конкурс'], ['прочие', null, 'Иные способы']];
/** Пояснение к «Иным способам» - под галочками способов. */
const ИНЫЕ_СПОСОБЫ = 'Иные способы - запрос предложений, конкурентный отбор и другие процедуры, которые заказчик по 223-ФЗ устанавливает в положении о закупке.';

/** Обеспечение из карточки закупки: «не требуется», «22 500 ₽ (1%)», «5%», «не указано». */
function текстОбеспечения(о) {
  if (!о) return 'не указано';
  if (о.требуется === false) return 'не требуется';
  const п = typeof о.процент === 'number' ? `${String(о.процент).replace('.', ',')}%` : '';
  if (typeof о.сумма === 'number') return `${деньги(о.сумма)}${п ? ` (${п})` : ''}`;
  return п || 'не указано';
}
/**
 * «По выгоде»: сначала рассчитанные с закупочными ценами - по запасу до
 * безубыточности при худшей цене, затем при лучшей; без вывода (одни цены
 * заказчика) и нерассчитанные - после, в прежнем порядке.
 */
function запасРасчёта(р) {
  if (!р || р.status !== 'готов' || !р.totals) return null;
  let и = null;
  try { и = JSON.parse(р.totals); } catch (e) { return null; }
  if (!и || !и.закупкаИзвестна || (и.позицийСЦеной > 0 && и.позицийПоПотолку === и.позицийСЦеной)) return null;
  const х = typeof и.запасПроцент === 'number' ? и.запасПроцент : null;
  const л = typeof и.запасПроцентЛучший === 'number' ? и.запасПроцентЛучший : х;
  return х === null && л === null ? null : { х: х ?? л, л: л ?? х };
}
function упорядочитьПоВыгоде(список, расчёты = {}, сорт) {
  if (сорт !== 'profit') return список;
  const с = список.map((т, i) => ({ т, i, з: запасРасчёта((расчёты || {})[т.номер]) }));
  с.sort((a, b) => (a.з && b.з ? (b.з.х - a.з.х) || (b.з.л - a.з.л) : (a.з ? -1 : b.з ? 1 : a.i - b.i)));
  return с.map((x) => x.т);
}

function текстПоСлову(текст, q) {
  const н = normalize(текст);
  if (н.includes(q)) return true;
  return q.length > 4 && !q.includes(' ') && естьОснова(н, основа(q));
}

/** Первая позиция спецификации, где есть слово, или null. */
const позицияПоСлову = (т, q) => (т.разбор && т.разбор.наименования || []).find((н) => текстПоСлову(н, q)) || null;

/** Нужно ли обеспечение заявки: true, false или null (неизвестно). */
const нужноОбеспечениеЗаявки = (т) => {
  const о = т.разбор && т.разбор.обеспечения && т.разбор.обеспечения.заявка;
  if (!о) return null;
  if (о.требуется === false) return false;
  return о.требуется === true || typeof о.сумма === 'number' || typeof о.процент === 'number' ? true : null;
};

/** «44-ФЗ Запрос котировок в электронной форме» → «44-ФЗ · Запрос котировок в электронной форме». */
function видЗакупки(закон) {
  const s = String(закон || '').trim();
  const m = s.match(/^(\d{2,3}-ФЗ)\s+(.+)$/);
  return m ? `${m[1]} · ${m[2]}` : s;
}

function способ(закон) {
  for (const [имя, ш] of СПОСОБЫ) if (ш && ш.test(String(закон || ''))) return имя;
  return 'прочие';
}

/** Отбор ленты по параметрам адреса. Чистая функция — под проверками. */
function отобратьЛенту(тендеры, отметки, п = {}) {
  const q = normalize(п.q);
  const исключая = String(п.ex || '').toLowerCase().split(',').map((с) => с.trim()).filter(Boolean);
  const кодыФильтра = String(п.okpd || '').split(/[\s,;]+/).map((к) => к.trim()).filter((к) => /^\d{2}(\.\d{1,2}){0,3}$/.test(к));
  // «Начальная цена от/до» из формы принимает «5 000 000» с пробелами и
  // запятую — иначе фильтр молча не применялся (владелец 15.11.2026).
  const суммаИз = (s) => {
    const чисто = String(s ?? '').replace(/[\s ]/g, '').replace(',', '.');
    const n = Number(чисто);
    return чисто !== '' && isFinite(n) ? n : null;
  };
  const от = суммаИз(п.from);
  const до = суммаИз(п.to);
  const дней = п.days === undefined || п.days === '' ? null : Number(п.days);
  const законы = [].concat(п.law || []).filter(Boolean);
  const способы = [].concat(п.method || []).filter(Boolean);
  const регионы = [].concat(п.region || []).filter(Boolean);
  const вид = п.view || 'active';

  let список = тендеры.filter((т) => {
    const м = отметки[т.номер] || {};
    if (вид === 'saved') { if (!м.saved) return false; } else if (вид === 'hidden') { if (!м.hidden) return false; } else if (м.hidden) return false;
    if (вид === 'active') { const д = днейДо(т.срок); if (д !== null && д < 0) return false; }
    if (q && !текстПоСлову(`${т.объект} ${т.заказчик} ${т.номер}`, q) && !позицияПоСлову(т, q)) return false;
    if (исключая.length && исключая.some((с) => String(т.объект || '').toLowerCase().includes(с))) return false;
    // «Без обеспечения заявки»: только те, где карточка прямо говорит «не требуется».
    if (п.nosec && нужноОбеспечениеЗаявки(т) !== false) return false;
    // «Товары» показывает и смешанные закупки, «Работы и услуги» - тоже:
    // поставка с монтажом нужна обоим.
    if (п.kind === 'goods' && предметЛенты(т) === 'работы и услуги') return false;
    if (п.kind === 'works' && предметЛенты(т) === 'товары') return false;
    // Код ОКПД2: «17.12» находит 17.12 и 17.12.14; код закупки неизвестен - не показывается.
    if (кодыФильтра.length && !(т.окпд || []).some((к) => кодыФильтра.some((ф) => к === ф || к.startsWith(ф + '.') || ф.startsWith(к + '.')))) return false;
    if (от !== null && !(typeof т.нмцк === 'number' && т.нмцк >= от)) return false;
    if (до !== null && !(typeof т.нмцк === 'number' && т.нмцк <= до)) return false;
    if (дней !== null && isFinite(дней)) { const д = днейДо(т.срок); if (д === null || д < 0 || д > дней) return false; }
    if (законы.length && !законы.some((з) => String(т.закон || '').includes(з))) return false;
    if (способы.length && !способы.includes(способ(т.закон))) return false;
    // Регион не определён (код 99, старая карточка) - при выбранном регионе не показывается.
    if (регионы.length && !регионы.includes(String(т.регион || ''))) return false;
    return true;
  });
  const сорт = п.sort || 'deadline';
  if (сорт === 'price') список = список.sort((a, b) => (b.нмцк || 0) - (a.нмцк || 0));
  else if (сорт === 'new') список = список.sort((a, b) => String(b.впервые || '').localeCompare(String(a.впервые || '')));
  return список;
}

/** Метки свежих изменений (за 7 дней): «изменился срок», «изменилась цена». */
function меткиИзменений(изменения = [], now = new Date()) {
  const граница = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
  const свежие = изменения.filter((и) => String(и.когда || '') >= граница);
  const текст = { deadline: 'изменился срок', price: 'изменилась цена', status: 'изменился статус' };
  return [...new Set(свежие.map((и) => и.поле))].filter((п) => текст[п]).map((п) => `<span class="tag hot">${текст[п]}</span>`).join('');
}

function значениеИзменения(поле, v) {
  if (v === null || v === undefined || v === '') return 'не указано';
  if (поле === 'price') return деньги(Number(v));
  if (поле === 'deadline') return дата(v);
  return esc(v);
}

function меткиРазбора(р) {
  if (!р) return '<span class="tag">документация не обработана</span>';
  if (р.вОчереди) return '<span class="tag">документация в обработке</span>';
  if (р.отменена) return '<span class="tag hot">закупка отменена</span>';
  if (р.пропущен) return '';
  if (р.ценаЗаЕдиницу) return '<span class="tag warn">по цене единицы товара</span>';
  if (р.ок && р.позиций) return `<span class="tag ok">спецификация: ${esc(р.позиций)} поз.${р.естьТЗ ? ' · ТЗ' : ''}</span>`;
  return '<span class="tag warn">спецификация не извлечена</span>';
}

/** Строка фильтров только из разрешённых полей - для сохранения набора и ссылок. */
const ПОЛЯ_ФИЛЬТРА = ['q', 'ex', 'okpd', 'nosec', 'kind', 'from', 'to', 'days', 'law', 'method', 'region', 'sort', 'view'];
/** Товары / работы и услуги у закупки ленты (src/item-kind.js, владелец 28.10.2026). */
const предметЛенты = (т) => видПредмета({ object: т.объект, группыОкпд2: т.окпд || [] });
function запросФильтра(п = {}) {
  const u = new URLSearchParams();
  for (const к of ПОЛЯ_ФИЛЬТРА) for (const з of [].concat(п[к] ?? [])) if (з !== '' && з !== undefined) u.append(к, String(з).slice(0, 100));
  return u.toString();
}

const процент = (x) => `${String(Math.round(x * 10) / 10).replace('.', ',')}%`;

/** Блок «Лучшие тендеры дня» (Макс). null - тариф без этой возможности. */
function блокЛучших(лучшие, планДня, макс) {
  if (!макс) {
    return `<div class="card small muted" style="margin-bottom:16px">Лучшие тендеры дня, уже посчитанные с поставщиками, - в тарифе <a href="/app/billing">Макс</a>.</div>`;
  }
  if (!лучшие || !лучшие.length) {
    return `<div class="card" style="margin-bottom:16px"><h2 style="margin:0 0 6px">Лучшие тендеры дня</h2>
      <p class="muted small" style="margin:0">${планДня ? 'Сегодняшние тендеры считаются: список появится здесь по мере готовности расчётов.' : 'Каждое утро после поиска система сама считает разобранные тендеры с поставщиками и показывает здесь пять лучших.'}</p></div>`;
  }
  return `<div class="card stack" style="margin-bottom:16px"><h2 style="margin:0">Лучшие тендеры дня</h2>
    <p class="small muted" style="margin:0">Посчитаны с поставщиками. Порядок - по запасу до безубыточности при худшей найденной цене.</p>
    ${лучшие.map((л, i) => {
      const з = л.худший !== null && л.лучший !== null && л.худший !== л.лучший
        ? `запас от ${процент(л.худший)} до ${процент(л.лучший)}` : `запас ${процент(л.лучший)}`;
      return `<a class="tender" href="/app/calc/${esc(л.расчёт)}" style="padding:12px 0;border-top:1px solid var(--line)">
        <div class="meta"><span class="mono" style="color:var(--orange-ink)">${i + 1}</span><b style="color:var(--ink)">${esc(л.тендер.объект || л.номер)}</b></div>
        <div class="meta"><span class="nmck">${деньги(л.тендер.нмцк)}</span><span>безубыточно от ${деньги(л.итоги.безубыточностьЛучшая ?? л.итоги.безубыточность)}</span><span class="tag ok" style="margin:0">${з}</span>${срокМетка(л.тендер.срок)}</div>
      </a>`;
    }).join('')}</div>`;
}

function лента({ пользователь, тендеры, отметки, п, обновлено, поиск, вОчереди, сообщ = '', наборы = [], лучшие = null, планДня = false, макс = false, расчёты = {}, пример = false, регионыНастроек = [], регионСклада = null }) {
  let список = упорядочитьПоВыгоде(отобратьЛенту(тендеры, отметки, п), расчёты, п.sort);
  if (п.sort === 'near' && регионСклада) {
    список = список.map((т, i) => ({ т, i, б: близость(т.регион, регионСклада) })).sort((a, b) => a.б - b.б || a.i - b.i).map((x) => x.т);
  }
  const меткаБлизости = (т) => {
    if (!регионСклада) return '';
    const б = близость(т.регион, регионСклада);
    return б === 0 ? '<span class="tag ok">ваш регион</span>' : б === 1 ? `<span class="tag">${esc(округРегиона(регионСклада))} ФО</span>` : '';
  };
  const сел = (имя, значение, текст) => `<option value="${esc(значение)}"${String(п[имя] || '') === String(значение) ? ' selected' : ''}>${esc(текст)}</option>`;
  const галка = (имя, значение, текст) => `<label class="check" style="margin:4px 0"><input type="checkbox" name="${имя}" value="${esc(значение)}"${[].concat(п[имя] || []).includes(значение) ? ' checked' : ''}><span>${esc(текст)}</span></label>`;
  const состояниеПоиска = поиск
    ? (поиск.status === 'ждёт' || поиск.status === 'идёт'
      ? '<div class="alert info" data-refresh="20">Идёт обновление ленты. Страница обновится сама.</div>'
      : `<p class="small muted">Лента обновлена ${esc(дата(поиск.finished || поиск.created))}${поиск.status === 'сбой' ? ' · обновление не удалось, повтор по расписанию' : ''}${вОчереди ? ` · документация в обработке: ${esc(вОчереди)}` : ''}</p>`)
    : '';
  const меткаРасчёта = (р) => {
    if (!р) return '';
    if (р.status === 'ждёт' || р.status === 'идёт') return '<span class="tag">расчёт выполняется</span>';
    if (р.status === 'сбой') return '<span class="tag warn">ошибка расчёта</span>';
    let и = null;
    try { и = р.totals ? JSON.parse(р.totals) : null; } catch (e) { и = null; }
    const в = вердикт(и);
    const з = запасРасчёта(р);
    const пр = (x) => `${String(Math.round(x * 10) / 10).replace('.', ',')}%`;
    const запас = з ? (з.х !== з.л ? ` · запас ${пр(з.х)}…${пр(з.л)}` : ` · запас ${пр(з.х)}`) : '';
    const текст = { ok: `расчёт: рентабельно${запас}`, warn: `расчёт: зависит от цены поставщика${запас}`, bad: `расчёт: убыточно${запас}`, info: 'расчёт готов' }[в.вид];
    const класс = { ok: 'ok', warn: 'warn', bad: 'hot', info: '' }[в.вид];
    return `<span class="tag ${класс}">${текст}</span>`;
  };
  const слово = normalize(п.q);
  const найденоВСпецификации = (т) => {
    if (!слово || текстПоСлову(т.объект, слово)) return '';
    const поз = позицияПоСлову(т, слово);
    return поз ? `<span class="tag ok">в спецификации: ${esc(поз.length > 60 ? поз.slice(0, 60) + '…' : поз)}</span>` : '';
  };
  const быстро = (т, действие, надпись) => `<form class="inline" method="post" action="/app/t/${encodeURIComponent(т.номер)}/quick">${скрытое(пользователь.csrf)}<input type="hidden" name="do" value="${действие}"><button class="btn secondary small">${надпись}</button></form>`;
  const карточки = список.length ? список.map((т) => {
    const м = отметки[т.номер] || {};
    const р = (расчёты || {})[т.номер];
    const главная = р && р.status === 'готов'
      ? `<a class="btn small" href="/app/calc/${esc(р.id)}">Открыть расчёт</a>`
      : `<a class="btn small" href="/app/t/${encodeURIComponent(т.номер)}">${р ? 'Открыть' : 'Рассчитать'}</a>`;
    // В примере закупки чужой ленты: действий нет, кнопка ведёт к настройке.
    const действия = пример
      ? '<a class="btn small" href="/app/onboarding">Выбрать категории</a>'
      : `${м.hidden ? быстро(т, 'unhide', 'Вернуть') : быстро(т, 'hide', 'Скрыть')}${м.saved ? быстро(т, 'unsave', 'Убрать из избранного') : быстро(т, 'save', 'В избранное')}${главная}`;
    const заголовок = пример
      ? `<span class="tc-title">${esc(т.объект || 'Объект закупки не указан')}</span>`
      : `<a class="tc-title" href="/app/t/${encodeURIComponent(т.номер)}">${esc(т.объект || 'Объект закупки не указан')}</a>`;
    const отметить = пример || (р && (р.status === 'ждёт' || р.status === 'идёт')) ? ''
      : `<label class="pick" title="Отметить для расчёта"><input type="checkbox" name="n" value="${esc(т.номер)}" form="bulk"></label>`;
    return `<article class="card tcard">
      <div class="tc-top">${отметить}<span class="tc-law">${esc(видЗакупки(т.закон))}</span><span class="tag" style="margin:0 0 0 8px">${esc(предметЛенты(т))}</span><span class="mono small muted" style="margin-left:auto">№ ${esc(т.номер)}</span></div>
      ${заголовок}
      <dl class="tc-grid">
        <div><dt>Начальная цена</dt><dd class="nmck">${деньги(т.нмцк)}</dd></div>
        <div><dt>Окончание подачи заявок</dt><dd>${esc(дата(т.срок))} ${срокМетка(т.срок)}</dd></div>
        <div><dt>Регион</dt><dd>${esc(названиеРегиона(т.регион) || 'не определён')}</dd></div>
        <div><dt>ОКПД2</dt><dd class="mono">${esc((т.окпд || []).join(', ') || 'не определён')}</dd></div>
        ${т.разбор && т.разбор.обеспечения ? `<div><dt>Обеспечение заявки</dt><dd>${текстОбеспечения(т.разбор.обеспечения.заявка)}</dd></div>
        <div><dt>Обеспечение контракта</dt><dd>${текстОбеспечения(т.разбор.обеспечения.контракт)}</dd></div>` : ''}
        <div class="wide"><dt>Заказчик</dt><dd>${esc(т.заказчик || 'не указан')}</dd></div>
      </dl>
      <div class="tc-bottom">
        <div>${найденоВСпецификации(т)}${меткаБлизости(т)}${меткаРасчёта(р)}${меткиИзменений(т.изменения)}${меткиРазбора(т.разбор)}${м.saved ? '<span class="tag">в избранном</span>' : ''}${м.decision ? `<span class="tag">${esc(м.decision)}</span>` : ''}</div>
        <div class="tc-actions">${действия}</div>
      </div>
    </article>`;
  }).join('') : (тендеры.length
    ? `<div class="card empty">По заданным фильтрам закупок нет. <a href="/app?region=all">Сбросить фильтры</a></div>`
    : `<div class="card empty stack"><div>Действующих закупок по вашим категориям пока нет.</div>
       <div class="small">Проверьте формулировки: в настройках кнопка «Проверить, сколько закупок найдётся» покажет результат по каждому слову.</div>
       <div><a class="btn small" href="/app/settings">Открыть настройки</a></div></div>`);
  const выбраноРегионов = [].concat(п.region || []).filter(Boolean).length;
  const блокРегионов = `<details class="regions"${выбраноРегионов ? ' open' : ''}><summary>Регион заказчика${выбраноРегионов ? `: выбрано ${выбраноРегионов}` : ': все'}</summary>
    ${регионыНастроек.length ? `<div class="hint" style="margin:4px 0">По умолчанию - регионы из настроек. <a href="/app?region=all">Все регионы</a></div>` : ''}
    <div class="regions-list">${СПИСОК_РЕГИОНОВ.map(([к, имя]) => галка('region', к, имя)).join('')}</div></details>`;

  const тело = `<h1>Тендеры</h1>${сообщение('ok', сообщ)}${состояниеПоиска}
${пример
    ? `<div class="alert info demo"><b>Пример ленты.</b> Показаны закупки по канцелярским товарам. Чтобы получать закупки по своим направлениям, выберите категории. <a class="btn small" href="/app/onboarding">Выбрать категории</a></div>`
    : блокЛучших(лучшие, планДня, макс)}
<div class="layout2">
  <aside class="feed-side">
  <details class="filters-box" open data-mobile-close><summary class="btn secondary small">Фильтры${запросФильтра(п) ? ' · заданы' : ''}</summary>
  <form class="card filters" method="get" action="/app">
    <label class="fl">Ключевые слова</label>
    <input type="text" name="q" value="${esc(п.q || '')}" placeholder="слово, № извещения, заказчик">
    <div class="hint" style="margin-top:-4px">Поиск и по позициям спецификации.</div>
    <label class="fl">Исключая</label>
    <input type="text" name="ex" value="${esc(п.ex || '')}" placeholder="через запятую">
    <label class="fl">Предмет закупки</label>
    <select name="kind">${сел('kind', '', 'Товары, работы и услуги')}${сел('kind', 'goods', 'Товары')}${сел('kind', 'works', 'Работы и услуги')}</select>
    <label class="fl">Код ОКПД2</label>
    <input type="text" name="okpd" value="${esc(п.okpd || '')}" placeholder="например: 17.12, 31.01">
    <label class="fl">Начальная цена, ₽</label>
    <div class="row"><input type="text" inputmode="numeric" name="from" value="${esc(п.from || '')}" placeholder="от"><input type="text" inputmode="numeric" name="to" value="${esc(п.to || '')}" placeholder="до"></div>
    <label class="fl">Окончание подачи заявок</label>
    <select name="days">${сел('days', '', 'любое')}${сел('days', '0', 'сегодня')}${сел('days', '3', 'в течение 3 дней')}${сел('days', '7', 'в течение недели')}</select>
    ${блокРегионов}
    <div>${галка('law', '44-ФЗ', '44-ФЗ')}${галка('law', '223-ФЗ', '223-ФЗ')}</div>
    <div>${галка('nosec', '1', 'Без обеспечения заявки')}</div>
    <div>${СПОСОБЫ.map(([и, , текст]) => галка('method', и, текст)).join('')}<div class="hint" style="margin-top:2px">${esc(ИНЫЕ_СПОСОБЫ)}</div></div>
    <select name="sort">${сел('sort', 'deadline', 'По сроку подачи')}${сел('sort', 'profit', 'По выгоде (рассчитанные первыми)')}${регионСклада ? сел('sort', 'near', 'Ближе к складу') : ''}${сел('sort', 'price', 'По НМЦК, по убыванию')}${сел('sort', 'new', 'По дате публикации')}</select>
    <select name="view">${сел('view', 'active', 'Актуальные')}${сел('view', 'saved', 'Избранное')}${сел('view', 'hidden', 'Скрытые')}${сел('view', 'all', 'Все, включая завершённые')}</select>
    <button class="btn small">Применить</button>
    <a class="small" href="/app">Сбросить</a>
  </form>
  <div class="card stack" style="margin-top:12px">
    <h3 style="margin:0">Сохранённые фильтры</h3>
    ${наборы.length ? наборы.map((н) => `<div><a href="/app?${esc(н.query)}">${esc(н.name)}</a>
      <form class="inline" method="post" action="/app/filters/${esc(н.id)}/delete">${скрытое(пользователь.csrf)}<button class="btn link small" title="Удалить">✕</button></form></div>`).join('')
      : '<p class="small muted" style="margin:0">Сохранённых фильтров нет.</p>'}
    ${запросФильтра(п) ? `<form method="post" action="/app/filters">${скрытое(пользователь.csrf)}<input type="hidden" name="query" value="${esc(запросФильтра(п))}">
      <input type="text" name="name" maxlength="60" placeholder="Название, например «Москва до 1 млн»" required>
      <p style="margin:8px 0 0"><button class="btn small secondary">Сохранить фильтр</button></p></form>` : ''}
  </div>
  </details>
  </aside>
  <div class="list"><div class="list-head"><p class="small muted" style="margin:0">Найдено: ${esc(список.length)}${обновлено ? ` · обновлено ${esc(дата(обновлено))}` : ''}</p>
    ${!пример && список.length ? `<div class="list-actions"><form id="bulk" class="inline" method="post" action="/app/calc-many">${скрытое(пользователь.csrf)}<button class="btn small">Рассчитать отмеченные</button></form>
      <a class="btn secondary small" href="/app/export.xlsx${запросФильтра(п) ? `?${esc(запросФильтра(п))}` : ''}">Выгрузить в Excel</a></div>` : ''}</div>${карточки}</div>
</div>`;
  return кабинет({ заголовок: 'Тендеры', тело, пользователь, активный: 'лента' });
}

/** Условия контракта и обеспечения - с цитатой из проекта контракта. */
function блокУсловий(т) {
  const р = т.разбор || {};
  const у = р.условия;
  const об = р.обеспечения;
  const нр = р.нацРежим;
  if (!у && !об && !нр) return '';
  // Цитаты убраны решением владельца 15.11.2026: «клиенту это не интересно».
  // Факт остаётся фактом: срок оплаты «30 дн.», а не дословный абзац договора.
  const строка = (подпись, значение) => `<div class="cond"><dt>${подпись}</dt><dd>${значение}</dd></div>`;
  const нет = '<span class="muted">не определено</span>';
  const дн = (о) => `${esc(о.дней)}${о.вид ? ` ${esc(о.вид)}` : ''} дн.`;
  const строки = [
    об ? строка('Обеспечение заявки', текстОбеспечения(об.заявка)) : '',
    об ? строка('Обеспечение исполнения контракта', текстОбеспечения(об.контракт)) : '',
    у ? строка('Аванс', у.аванс ? (у.аванс.есть ? `${esc(String(у.аванс.процент).replace('.', ','))}%` : 'не предусмотрен') : нет, у.аванс && у.аванс.цитата) : '',
    у ? строка('Срок оплаты', у.оплата ? `${дн(у.оплата)} после приёмки` : нет, у.оплата && у.оплата.цитата) : '',
    // По заявкам - дни и общий срок «до» вместе; срок из описания объекта
    // закупки (в проекте не проставлен) - с названием документа (25.10.2026).
    у ? строка('Срок поставки', у.поставка ? [
      у.поставка.дней ? `${дн(у.поставка)} ${esc(у.поставка.отсчёт || '')}`.trim() : '',
      у.поставка.до ? `до ${esc(у.поставка.до)}` : ''
    ].filter(Boolean).join(', ') + (у.поставка.документ ? ` (по документу «${esc(у.поставка.документ)}»)` : '') : нет, у.поставка && у.поставка.цитата) : '',
    // Новые условия (24.10.2026) - строкой только найденные: у разборов до
    // этой даты их нет вовсе, «не определено» на десяти строках было бы шумом.
    у && у.приёмка ? строка('Срок приёмки', `${дн(у.приёмка)} ${esc(у.приёмка.отсчёт || 'с поступления документа о приёмке')}`, у.приёмка.цитата) : '',
    у && у.штраф ? строка('Штраф за неисполнение', (() => {
      const с = require('../src/contract-terms').штрафДляЦены(у.штраф, т.нмцк);
      // Сумма в проекте не проставлена - её задаёт ПП № 1042 (25.10.2026).
      if (у.штраф.поПравилам) {
        return с ? `по ПП № 1042 (в проекте не проставлен): ${esc(String(с.процент).replace('.', ','))}% цены контракта, ${деньги(с.сумма)}, если цена равна НМЦК; для контракта с СМП - 1%, не более ${деньги(5000)}` : 'по шкале ПП № 1042, см. цитату';
      }
      return с ? `${esc(String(с.процент).replace('.', ','))}% цены контракта: ${деньги(с.сумма)}, если цена равна НМЦК` : 'по шкале ПП № 1042, см. цитату';
    })(), у.штраф.цитата) : '',
    у && у.пеня ? строка('Пеня за просрочку', esc(у.пеня.доля), у.пеня.цитата) : '',
    у && у.гарантия ? строка('Обеспечение гарантии', у.гарантия.есть
      ? `${esc(String(у.гарантия.процент).replace('.', ','))}%${т.нмцк > 0 ? `: ${деньги(Math.round(т.нмцк * у.гарантия.процент) / 100)} от НМЦК` : ''}` : 'не требуется', у.гарантия.цитата) : '',
    у && у.гарантийныйСрок ? строка('Гарантийный срок', `${esc(у.гарантийныйСрок.месяцев)} мес.`, у.гарантийныйСрок.цитата) : '',
    у && у.годность ? строка('Остаточный срок годности', `не менее ${esc(у.годность.значение)} ${esc(у.годность.ед)}`, у.годность.цитата) : '',
    у && у.партиями ? строка('Поставка', 'партиями / по заявкам заказчика', у.партиями.цитата) : '',
    у && у.разгрузка ? строка('Разгрузка', 'входит в цену - за счёт поставщика', у.разгрузка.цитата) : '',
    у && у.казначейство ? строка('Казначейское сопровождение', у.казначейство.есть ? 'да' : 'нет', у.казначейство.цитата) : '',
    у && у.смп ? строка('Участники', 'только СМП и СОНКО', у.смп.цитата) : '',
    нр && нр.виды.length ? строка('Национальный режим', esc({ запрет: 'запрет иностранных товаров', ограничение: 'ограничение иностранных товаров', преимущество: 'преимущество российским товарам' }[нр.виды[0]] + (нр.виды.length > 1 ? ` и ещё: ${нр.виды.slice(1).join(', ')}` : '')),
      нр.строки.map((с) => `${с.объект}: ${с.вид}`).join(' · ')) : ''
  ].join('');
  return `<div class="card stack" style="margin-top:16px"><h2 style="margin:0">Условия контракта</h2>
    <dl class="conds">${строки}</dl></div>`;
}

/** Как падала цена у похожих прошлых закупок (протоколы). */
function блокПохожих(х) {
  if (!х) return '';
  const з = (x) => `${String(x).replace('.', ',')}%`;
  if (!х.оценена) {
    return `<div class="card stack" style="margin-top:16px"><h2 style="margin:0">Похожие прошлые закупки</h2>
      <p class="small muted" style="margin:0">Недостаточно данных: ${esc(х.причина)}. База прошлых закупок пополняется каждую ночь по ключевым словам клиентов.</p></div>`;
  }
  const примеры = (х.примеры || []).map((п) => `<tr><td class="mono">${esc(п.номер)}</td><td class="nowrap">${деньги(п.нмцк)}</td><td class="mono">${з(п.снижение)}</td><td>${п.участников ?? '—'}</td></tr>`).join('');
  return `<div class="card stack" style="margin-top:16px"><h2 style="margin:0">Похожие прошлые закупки: снижение цены</h2>
    <div class="kpis" style="margin:0">
      <div class="card kpi"><div class="small muted">Обычно</div><div class="v">${з(х.медиана)}</div></div>
      <div class="card kpi"><div class="small muted">У половины закупок</div><div class="v">${з(х.q1)} - ${з(х.q3)}</div></div>
      <div class="card kpi"><div class="small muted">Наибольшее</div><div class="v">${з(х.до)}</div></div>
      <div class="card kpi"><div class="small muted">Участников обычно</div><div class="v">${х.медианаУчастников ?? '—'}</div></div>
    </div>
    <p class="small muted" style="margin:0">По ${esc(х.похожих)} прошлым закупкам: ${esc(х.причина)}${х.единственных ? `; закупки с одной заявкой (${esc(х.единственных)}) не учитывались` : ''}.</p>
    ${примеры ? `<div class="scroll"><table class="t"><tr><th>№ закупки</th><th>Начальная цена</th><th>Снижение</th><th>Участников</th></tr>${примеры}</table></div>` : ''}</div>`;
}

function карточка({ пользователь, т, отметка, расчёты, д, сообщ = '', ошибка = '', шанс = null, похожие = null }) {
  const м = отметка || {};
  const идёт = расчёты.some((р) => р.status === 'ждёт' || р.status === 'идёт');
  const кнопка = идёт
    ? '<div class="alert info" data-refresh="60">Расчёт выполняется. Обычно это 2–3 минуты, страница обновится сама — можно вернуться к ленте.</div>'
    : (д.можноСчитать
      ? `<form method="post" action="/app/t/${encodeURIComponent(т.номер)}/calc">${скрытое(пользователь.csrf)}<button class="btn">Рассчитать</button></form>
         <p class="small muted">${д.пробный ? `Осталось расчётов в пробном периоде: ${esc(д.осталось)}. ` : ''}После нажатия расчёт идёт 2–3 минуты, страница обновится сама.</p>`
      : `<p class="muted">${esc(д.причина)}</p><p><a class="btn secondary small" href="/app/billing">Тариф</a></p>`);
  const список = расчёты.length ? `<table class="t"><tr><th>Расчёт</th><th>Статус</th></tr>${расчёты.map((р) =>
    `<tr><td><a href="/app/calc/${esc(р.id)}">${esc(дата(р.created))}</a></td><td>${esc(р.status)}</td></tr>`).join('')}</table>` : '';
  const решение = (з, текст) => `<option value="${з}"${м.decision === з ? ' selected' : ''}>${текст}</option>`;
  const плитка = (подпись, значение) => `<div class="card kpi"><div class="small muted">${подпись}</div><div class="v" style="font-size:1.05rem">${значение}</div></div>`;
  const тело = `<p class="small"><a href="/app">← Тендеры</a></p>
${сообщение('ok', сообщ)}${сообщение('bad', ошибка)}
<div class="tender-head">
  <div>
    <div class="mono small muted">№ ${esc(т.номер)}${т.закон ? ` · ${esc(т.закон)}` : ''}</div>
    <h1 style="font-size:1.6rem;margin:8px 0 6px">${esc(т.объект || 'Объект закупки не указан')}</h1>
    <div class="small muted">${esc(т.заказчик || 'заказчик не указан')}${т.url && /^https:\/\/zakupki\.gov\.ru\//.test(т.url) ? ` · <a href="${esc(т.url)}" target="_blank" rel="noopener noreferrer">открыть на портале закупок</a>` : ''}</div>
  </div>
</div>
<div class="kpis">
  ${плитка('Начальная цена', деньги(т.нмцк))}
  ${плитка('Подача заявок до', `${дата(т.срок)} ${срокМетка(т.срок)}`)}
  ${плитка('Регион заказчика', esc(названиеРегиона(т.регион) || 'не определён'))}
  ${плитка('Документация', меткиРазбора(т.разбор) || 'не обрабатывалась')}
</div>
<div class="grid c2">
  <div class="card stack"><h2 style="margin:0">Расчёт</h2>${кнопка}${список}</div>
  <div class="card"><h2>Решение и заметка</h2>
      <form method="post" action="/app/t/${encodeURIComponent(т.номер)}/mark">${скрытое(пользователь.csrf)}
        <select name="decision">${решение('', 'Не решено')}${решение('участвую', 'Участвую')}${решение('думаю', 'Думаю')}${решение('не участвую', 'Не участвую')}</select>
        <label for="n">Заметка</label><textarea id="n" name="note" maxlength="2000">${esc(м.note || '')}</textarea>
        <label class="check"><input type="checkbox" name="saved" value="1"${м.saved ? ' checked' : ''}><span>Сохранить в избранное</span></label>
        <label class="check"><input type="checkbox" name="hidden" value="1"${м.hidden ? ' checked' : ''}><span>Скрыть из ленты</span></label>
        <p style="margin-top:12px"><button class="btn small">Сохранить</button></p>
      </form></div>
</div>
${блокУсловий(т)}
${блокПохожих(похожие)}
${(т.изменения || []).length ? `<div class="card stack" style="margin-top:16px"><h2 style="margin:0">Изменения извещения</h2><ul style="margin:0">${[...т.изменения].reverse().map((и) =>
  `<li>${esc(дата(и.когда))}: ${esc(и.что)} — ${значениеИзменения(и.поле, и.было)} → <b>${значениеИзменения(и.поле, и.стало)}</b></li>`).join('')}</ul></div>` : ''}`;
  return кабинет({ заголовок: т.объект || т.номер, тело, пользователь, активный: 'лента' });
}

function число(итоги, ...ключи) {
  for (const к of ключи) {
    const v = итоги && итоги[к];
    if (typeof v === 'number' && isFinite(v)) return v;
    if (v && typeof v === 'object' && typeof v.всего === 'number') return v.всего;
  }
  return null;
}

/**
 * Вывод расчёта одной плашкой - по тем же правилам, что подпись в Telegram
 * (app/estimate-run.js): по одним ценам обоснования НМЦК вывод не делается,
 * развилка «зависит от поставщика» называется прямо.
 */
function вердикт(и) {
  const пр = (x) => `${String(Math.round(x * 10) / 10).replace('.', ',')}%`;
  if (!и || !и.закупкаИзвестна) return { вид: 'info', заголовок: 'Стоимость закупки не определена', текст: 'Цены по позициям не найдены, поэтому вывод о выгодности не делается.' };
  const всего = и.позицийВсего;
  const сЦеной = и.позицийСЦеной;
  if (сЦеной > 0 && и.позицийПоПотолку === сЦеной) {
    return { вид: 'info', заголовок: 'Вывод о выгодности не сделан', текст: 'Закупочных цен не найдено: все цены взяты из обоснования заказчика, а он и вывел из них начальную цену. Ответ появится, когда будут цены поставщиков или ваш прайс.' };
  }
  const неполная = typeof всего === 'number' && typeof сЦеной === 'number' && сЦеной < всего ? ` Цена найдена не для всех позиций (${сЦеной} из ${всего}) - вывод предварительный.` : '';
  const х = typeof и.запасПроцент === 'number' ? и.запасПроцент : null;
  const л = typeof и.запасПроцентЛучший === 'number' ? и.запасПроцентЛучший : х;
  if (х !== null && х > 0) {
    return { вид: 'ok', заголовок: 'Выгодно при любой из найденных цен', текст: `Запас до начальной цены ${л !== х ? `от ${пр(х)} до ${пр(л)}` : пр(х)}, в зависимости от того, у кого купить.${неполная}` };
  }
  if (л !== null && л > 0) {
    return { вид: 'warn', заголовок: 'Исход зависит от поставщика', текст: `По лучшей найденной цене запас ${пр(л)}, по худшей контракт убыточен. Согласуйте цену с поставщиком до подачи заявки.${неполная}` };
  }
  return { вид: 'bad', заголовок: 'Убыточно по найденным ценам', текст: `Расходы не ниже начальной цены даже по лучшей найденной цене.${неполная}` };
}

/** Запросы цены поставщикам и их ответы (Макс). Ответ - чужой текст: только через esc. */
function блокКП(кп, очередь) {
  if (!кп && !очередь) return '';
  if (!кп) {
    if (/не разрешил/.test(очередь)) {
      return '<div class="card small" style="margin-top:16px">Запросы цены поставщикам не отправлялись: в настройках не разрешено указывать название и ИНН вашей компании. Поставщики называют цену только известному покупателю. <a href="/app/settings">Включить в настройках</a></div>';
    }
    return `<div class="card small muted" style="margin-top:16px">${очередь === 'ждёт' ? 'Запросы цены поставщикам готовятся к отправке.' : `Запросы цены поставщикам: ${esc(очередь)}.`}</div>`;
  }
  const ответы = кп.ответы.map((о) => `<div style="padding:12px 0;border-top:1px solid var(--line)">
      <div><b>${esc(о.имя || 'поставщик')}</b> <span class="small muted">· ${esc(дата(о.когда))}${о.url && /^https?:\/\//i.test(о.url) ? ` · <a href="${esc(о.url)}" target="_blank" rel="noopener noreferrer nofollow">сайт</a>` : ''}</span></div>
      ${(о.суммы || []).length ? `<div class="small" style="margin-top:4px">Суммы в ответе: ${о.суммы.map((с) => `<b>${деньги(с.сумма)}</b>`).join(', ')}</div>` : ''}
      <div class="caption small" style="margin-top:6px">${esc(о.текст)}</div></div>`).join('');
  return `<div class="card stack" style="margin-top:16px"><h2 style="margin:0">Ответы поставщиков на запрос цены</h2>
    <p class="small muted" style="margin:0">Запрос отправлен: ${esc(кп.отправлено)}${кп.безПочты ? ` · без почты на сайте: ${esc(кп.безПочты)}` : ''} · ответили: ${esc(кп.ответы.length)}. Цены из ответов в расчёт сами не подставляются: проверьте единицу и условия.</p>
    ${ответы || '<p class="muted small" style="margin:0">Ответов пока нет. Обычно поставщики отвечают в течение дня.</p>'}</div>`;
}

function расчёт({ пользователь, р, т, шансДоступен = false, кп = null, кпОчередь = null }) {
  const { текстШанса } = require('../src/chance');
  const ждём = р.status === 'ждёт' || р.status === 'идёт';
  const итоги = р.totals ? JSON.parse(р.totals) : null;
  let тело = `<p class="small">${р.upload ? '<a href="/app/history">← К истории расчётов</a> · <a href="/app/upload">Посчитать ещё закупку по документам</a>' : `<a href="/app/t/${encodeURIComponent(р.number)}">← К тендеру</a>`}</p>
  <h1 style="font-size:1.4rem">Расчёт · ${esc((т && т.объект) || р.number)}</h1>`;
  if (ждём) {
    тело += `<div class="card stack"><p>${р.status === 'ждёт' ? 'Расчёт в очереди.' : 'Идёт расчёт: скачиваем документацию, читаем ТЗ, разбираем позиции, ищем поставщиков.'}</p>
    <p class="muted small">Страница обновится сама. Её можно закрыть: расчёт сохранится в истории.</p></div>
    <div data-refresh="15"></div>`;
  } else if (р.status === 'сбой') {
    тело += `<div class="card stack"><p>Расчёт не удался: ${esc(р.error || 'причина не указана')}.</p>
    <p class="muted small">Попытка в пробном периоде не списана. Закупка передана на разбор специалисту.</p></div>`;
  } else {
    const закупкаИзв = итоги && итоги.закупкаИзвестна;
    const диапазон = (а, б) => (а !== null && б !== null && Math.round(а) !== Math.round(б) ? `${деньги(Math.min(а, б))} - ${деньги(Math.max(а, б))}` : деньги(б !== null ? б : а));
    const в = вердикт(итоги);
    const заявка = число(итоги, 'обеспечениеЗаявки');
    const контракт = число(итоги, 'обеспечениеКонтракта');
    const плитка = (подпись, значение, пояснение = '') => `<div class="card kpi"><div class="small muted">${подпись}</div><div class="v">${значение}</div>${пояснение ? `<div class="small muted">${пояснение}</div>` : ''}</div>`;
    const ключевые = итоги ? `<div class="verdict ${в.вид}"><div class="vt">${esc(в.заголовок)}</div><p>${esc(в.текст)}</p></div>
      <div class="kpis">
        ${плитка('Начальная цена контракта', деньги(число(итоги, 'нмцк')))}
        ${плитка('Цена, ниже которой убыток', закупкаИзв ? диапазон(число(итоги, 'безубыточностьЛучшая'), число(итоги, 'безубыточность')) : 'не определена')}
        ${плитка('Стоимость закупки', закупкаИзв ? диапазон(число(итоги, 'закупкаМин'), число(итоги, 'закупкаМакс') ?? число(итоги, 'закупка')) : 'не определена')}
        ${плитка('Требуемый объём средств', деньги(число(итоги, 'деньги')), заявка !== null || контракт !== null ? `обеспечения: заявки ${деньги(заявка ?? 0)}, контракта ${деньги(контракт ?? 0)}` : '')}
      </div>` : '';
    const шанс = итоги && итоги.шанс
      ? (шансДоступен
        ? `<div class="card stack" style="margin-bottom:16px"><h2 style="margin:0">Шанс на победу</h2><p style="margin:0">${esc(текстШанса(итоги.шанс))}</p>
           <p class="small muted" style="margin:0">По протоколам прошлых закупок с портала закупок: тот же способ, сумма и товар.</p></div>`
        : '<div class="card small muted" style="margin-bottom:16px">Шанс на победу по ценам прошлых побед - в тарифе <a href="/app/billing">Макс</a>.</div>')
      : '';
    // Прогноз цены победы (src/win-forecast.js) - Макс, и только после пройденной
    // обратной проверки: до неё вероятности клиенту не показываются (28.10.2026).
    const прогноз = шансДоступен && итоги && итоги.прогноз && итоги.прогноз.показан
      ? `<div class="card stack" style="margin-bottom:16px"><h2 style="margin:0">Прогноз цены победы</h2><p style="margin:0">${esc(require('../src/win-forecast').текстПрогноза(итоги.прогноз))}</p></div>`
      : '';
    тело += `${р.file_name ? `<div class="calc-actions"><a class="btn" href="/app/calc/${esc(р.id)}/xlsx">Скачать Excel</a><span class="small muted">все позиции, цены с источниками, поставщики и формулы</span></div>` : ''}
      ${ключевые}${шанс}${прогноз}
      <div class="card stack"><h2 style="margin:0">Подробно</h2><div class="caption">${безопаснаяПодпись(р.caption || '')}</div></div>${блокКП(кп, кпОчередь)}`;
  }
  return кабинет({ заголовок: 'Расчёт', тело, пользователь, активный: 'история' });
}

const СТАТУС_РАСЧЁТА = { 'ждёт': 'в очереди', 'идёт': 'выполняется', 'готов': 'готов', 'сбой': 'ошибка расчёта' };

function история({ пользователь, расчёты, тендеры, отметки, сообщ = '' }) {
  const поНомеру = Object.fromEntries(тендеры.map((т) => [т.номер, т]));
  const участвую = Object.values(отметки).filter((м) => м.decision === 'участвую');
  const идут = расчёты.some((р) => р.status === 'ждёт' || р.status === 'идёт');
  const строкиРасчётов = расчёты.length ? `<div class="scroll"><table class="t"><tr><th>Дата</th><th>Тендер</th><th>Статус</th></tr>${расчёты.map((р) =>
    `<tr><td class="nowrap"><a href="/app/calc/${esc(р.id)}">${esc(дата(р.created))}</a></td><td><a href="/app/calc/${esc(р.id)}">${esc((поНомеру[р.number] || {}).объект || р.number)}</a></td><td>${esc(СТАТУС_РАСЧЁТА[р.status] || р.status)}</td></tr>`).join('')}</table></div>`
    : '<p class="muted">Расчётов пока нет. Отметьте тендеры в ленте и нажмите «Рассчитать отмеченные» или откройте тендер и нажмите «Рассчитать».</p>';
  const строкиУчастия = участвую.length ? `<ul>${участвую.map((м) =>
    `<li><a href="/app/t/${encodeURIComponent(м.number)}">${esc((поНомеру[м.number] || {}).объект || м.number)}</a>${м.note ? ` — <span class="muted">${esc(м.note.slice(0, 120))}</span>` : ''}</li>`).join('')}</ul>`
    : '<p class="muted">Отметьте тендер «Участвую» в его карточке — он появится здесь.</p>';
  const тело = `<h1>История</h1>${сообщение('ok', сообщ)}${идут ? '<div data-refresh="20"></div>' : ''}<div class="grid c2"><div class="card"><h2>Расчёты</h2>${строкиРасчётов}</div><div class="card"><h2>Участвую</h2>${строкиУчастия}</div></div>`;
  return кабинет({ заголовок: 'История', тело, пользователь, активный: 'история' });
}

function настройки({ пользователь, н = {}, сообщ = '', ошибка = '', поиск = null, проверка = null }) {
  const список = (v) => esc((v || []).join('\n'));
  const законы = н.законы || [];
  const галка = (з) => `<label class="check" style="margin:4px 0"><input type="checkbox" name="law" value="${з}"${законы.includes(з) ? ' checked' : ''}><span>${з}</span></label>`;
  const налог = (v, t) => `<option value="${v}"${String(н.налог ?? '') === String(v) ? ' selected' : ''}>${t}</option>`;
  const выбрано = new Set(н.категории || []);
  // До 22.10.2026 категорий в настройках не было: слова клиента целиком - «свои».
  const свои = н.категории ? (н.своиСлова || []) : (н.слова || []);
  const стоп = разобратьСтоп(н);
  const регионы = new Set(н.регионы || []);
  const тело = `<h1>Настройки</h1>${сообщение('ok', сообщ)}${сообщение('bad', ошибка)}
${блокПроверки(проверка)}
<form class="stack" method="post" action="/app/settings" style="max-width:900px">${скрытое(пользователь.csrf)}
  <div class="card stack"><h2 style="margin:0">Категории</h2>
    ${сеткаКатегорий(выбрано)}
    <div><label for="w">Дополнительные ключевые слова</label><textarea id="w" name="words" rows="3" placeholder="например: кабель ВВГнг&#10;светильники светодиодные">${esc(свои.join('\n'))}</textarea>
    <div class="hint">По одному слову или словосочетанию на строку. Формулировки - как в названиях закупок.</div></div>
    <div><label for="ok">Дополнительные коды ОКПД2</label><input id="ok" type="text" name="okpd" value="${esc((н.своиКоды || []).join(', '))}" placeholder="например: 17.12, 31.01.1">
    <div class="hint">Закупка попадает в ленту по ключевому слову в названии или по коду ОКПД2. Коды выбранных категорий: ${esc(кодыКатегорий(н.категории || [], []).join(', ') || 'нет')}.</div></div>
    <label class="check"><input type="checkbox" name="services" value="1"${стоп.работыУслуги ? ' checked' : ''}><span>Показывать закупки работ и услуг: монтаж, обслуживание, ремонт, аренда</span></label>
    <div><label for="s">Исключая</label><textarea id="s" name="stop" rows="2" placeholder="по одному слову на строку">${esc(стоп.свои.join('\n'))}</textarea>
    <div class="hint">Закупки с этими словами в объекте закупки не показываются.</div></div>
  </div>
  <div class="card stack"><h2 style="margin:0">Условия отбора</h2>
    <div class="grid c2"><div><label for="f">Начальная цена от, ₽</label><input id="f" type="text" inputmode="numeric" name="from" min="0" value="${esc(н.ценаОт ?? '')}"></div>
    <div><label for="t">до, ₽</label><input id="t" type="text" inputmode="numeric" name="to" min="0" value="${esc(н.ценаДо ?? '')}"></div></div>
    <div><label>Законы</label>${галка('44-ФЗ')}${галка('223-ФЗ')}<div class="hint">Ничего не отмечено - оба.</div></div>
    <div><label>Регион заказчика</label>
      <details class="regions"><summary>${регионы.size ? `выбрано: ${регионы.size}` : 'все регионы'}</summary>
      <div class="regions-list">${СПИСОК_РЕГИОНОВ.map(([к, имя]) => `<label class="check" style="margin:4px 0"><input type="checkbox" name="region" value="${к}"${регионы.has(к) ? ' checked' : ''}><span>${esc(имя)}</span></label>`).join('')}</div></details>
      <div class="hint">Лента по умолчанию показывает закупки этих регионов. В фильтре ленты можно выбрать другие.</div></div>
    <div><label for="wh">Регион склада (отгрузки)</label>
      <select id="wh" name="warehouse"><option value="">не указан</option>${СПИСОК_РЕГИОНОВ.map(([к, имя]) => `<option value="${к}"${н.регионСклада === к ? ' selected' : ''}>${esc(имя)}</option>`).join('')}</select>
      <div class="hint">Для сортировки ленты «Ближе к складу»: сначала ваш регион, затем ваш федеральный округ.</div></div>
  </div>
  <div class="card stack"><h2 style="margin:0">Запросы цены поставщикам</h2>
    <p class="small muted" style="margin:0">Система сама пишет найденным поставщикам и собирает их цены. Поставщики называют цену только известному покупателю, поэтому в запросе указываются название и ИНН вашей компании. Без разрешения запросы не отправляются.</p>
    <div class="grid c2"><div><label for="bn">Название компании для поставщиков</label><input id="bn" type="text" name="buyer_name" maxlength="160" value="${esc((н.реквизиты && н.реквизиты.название) || '')}" placeholder="ООО «Пример»"></div>
    <div><label for="bi">ИНН</label><input id="bi" type="text" name="buyer_inn" inputmode="numeric" maxlength="12" value="${esc((н.реквизиты && н.реквизиты.инн) || '')}"></div></div>
    <label class="check"><input type="checkbox" name="buyer_consent" value="1"${н.реквизиты && н.реквизиты.согласие ? ' checked' : ''}><span>Разрешаю указывать название и ИНН моей компании в запросах цены поставщикам</span></label>
  </div>
  <div class="card stack"><h2 style="margin:0">Расчёт</h2>
    <div><label for="tax">Налоговый режим</label><select id="tax" name="tax">${налог('', 'не указан')}${налог(0.06, 'УСН «доходы», 6%')}${налог(0.15, 'УСН «доходы минус расходы», 15%')}${налог(0.2, 'ОСН, 20% (ООО — налог на прибыль; ИП — НДФЛ, шкала 13–22%)')}</select></div>
  </div>
  <div class="form-actions"><button class="btn">Сохранить</button>
    <button class="btn secondary" formaction="/app/settings/check">Проверить, сколько закупок найдётся</button></div>
</form>
<div class="card" style="max-width:900px;margin-top:16px"><h2>Обновление ленты</h2>
  <p class="muted small">Лента обновляется ежедневно утром и сразу после изменения категорий.</p>
  ${поиск && (поиск.status === 'ждёт' || поиск.status === 'идёт') ? '<p>Обновление идёт.</p>'
    : `<form method="post" action="/app/search-now">${скрытое(пользователь.csrf)}<button class="btn secondary small">Обновить сейчас</button></form>`}
</div>`;
  return кабинет({ заголовок: 'Настройки', тело, пользователь, активный: 'настройки' });
}

function прайс({ пользователь, н = {}, сообщ = '', ошибка = '', замечания = [] }) {
  const п = н.прайс;
  const тело = `<h1>Мой прайс</h1>${сообщение('ok', сообщ)}${сообщение('bad', ошибка)}
${замечания.length ? `<div class="alert info">Замечания по файлу:<ul>${замечания.map((з) => `<li>${esc(з)}</li>`).join('')}</ul></div>` : ''}
<div class="grid c2">
  <div class="card stack">
    <p>${п ? `Загружен ${esc(дата(п.когда))}: «${esc(п.имя)}», позиций ${esc(п.позиций)}. Новый файл заменит прежний.` : 'Прайс не загружен. Без него цены берутся из обоснования заказчика и у найденных поставщиков.'}</p>
    ${п && typeof п.товаров === 'number' ? `<dl class="kv"><dt>Товары</dt><dd>${esc(п.товаров)}</dd><dt>Работы и услуги</dt><dd>${esc(п.работ)}</dd></dl>
    <p class="small">Прайс разделён на товары и работы автоматически. Цена работы не подставляется в товар, и наоборот.</p>` : ''}
    <form method="post" action="/app/price" enctype="multipart/form-data">${скрытое(пользователь.csrf)}
      <label for="f">Файл Excel или CSV</label><input id="f" type="file" name="file" accept=".xlsx,.csv" required>
      <p style="margin-top:14px"><button class="btn">Загрузить</button></p>
    </form>
  </div>
  <div class="card stack">
    <h3>Что нужно в файле</h3>
    <ul><li>столбец с наименованием товара, работы или услуги;</li><li>столбец с ценой (если цен две — «с НДС» и «без НДС» — берётся с НДС);</li><li>по желанию: артикул, единица, поставщик.</li></ul>
    <p class="small">Товары и работы можно держать в одном файле: сервис сам разделит их по наименованию и единице.</p>
    <p class="small muted">Подходит выгрузка номенклатуры из 1С в Excel. Файл проверяется целиком: если в нём ошибка, он не применяется, и действует прежний прайс.</p>
    <p class="small muted">Прайс хранится на нашем сервере в России и никому не передаётся, включая разработчиков ИИ: сопоставление с позициями тендера идёт на нашем сервере.</p>
  </div>
</div>`;
  return кабинет({ заголовок: 'Мой прайс', тело, пользователь, активный: 'прайс' });
}

/**
 * Расчёт по загруженным документам (31.10.2026): закупка с любой площадки -
 * коммерческие на Сбербанк-АСТ, B2B-Center и другие, которых нет в ЕИС.
 */
function загрузка({ пользователь, д = {}, ошибка = '', поля = {} }) {
  const з = (имя) => esc(String((Array.isArray(поля[имя]) ? поля[имя][0] : поля[имя]) || ''));
  const { СПОСОБЫ } = require('./upload-form');
  const способ = з('method');
  const тело = `<h1>Расчёт по документам</h1>${сообщение('bad', ошибка)}
<p class="muted" style="max-width:820px">Для закупок с любой площадки: коммерческие на Сбербанк-АСТ, B2B-Center, Фабриканте и других, которых нет в ЕИС. Загрузите документы закупки и впишите начальную цену - расчёт будет таким же, как у закупки из ленты: позиции, закупочные цены, обеспечения, прибыль, файл Excel.</p>
${д.можноСчитать === false ? `<div class="alert info">${esc(д.причина || 'Расчёты по тарифу закончились.')} <a href="/app/billing">Тариф</a></div>` : ''}
<form class="stack" method="post" action="/app/upload" enctype="multipart/form-data" style="max-width:900px">${скрытое(пользователь.csrf)}
  <div class="card stack"><h2 style="margin:0">Документы закупки</h2>
    <label for="files">Файлы: техническое задание, спецификация, обоснование цены, проект договора</label>
    <input id="files" type="file" name="files" multiple required accept=".doc,.docx,.xls,.xlsx,.xlsm,.pdf,.rtf,.odt,.ods,.txt,.csv,.zip,.rar,.7z,.jpg,.jpeg,.png,.tif,.tiff">
    <p class="small muted" style="margin:0">До 15 файлов, до 30 МБ вместе. Подходят Word, Excel, PDF, сканы и фото, архивы с документацией целиком.</p>
  </div>
  <div class="card stack"><h2 style="margin:0">О закупке</h2>
    <div class="grid c2">
      <div><label for="object">Предмет закупки *</label><input id="object" name="object" maxlength="300" required value="${з('object')}" placeholder="Поставка пакетов фасовочных"></div>
      <div><label for="nmck">Начальная цена, ₽ *</label><input id="nmck" name="nmck" inputmode="decimal" required value="${з('nmck')}" placeholder="250000"></div>
      <div><label for="customer">Заказчик</label><input id="customer" name="customer" maxlength="300" value="${з('customer')}"></div>
      <div><label for="deadline">Срок подачи заявок</label><input id="deadline" name="deadline" type="date" value="${з('deadline')}"></div>
      <div><label for="platform">Площадка</label><input id="platform" name="platform" maxlength="100" value="${з('platform')}" placeholder="Сбербанк-АСТ"></div>
      <div><label for="method">Способ</label><select id="method" name="method"><option value="">не указан</option>${СПОСОБЫ.map((с) => `<option value="${с}"${способ === с ? ' selected' : ''}>${с}</option>`).join('')}</select></div>
      <div><label for="bid">Обеспечение заявки, %</label><input id="bid" name="bid" inputmode="decimal" value="${з('bid')}" placeholder="0 - не требуется"></div>
      <div><label for="contract">Обеспечение договора, %</label><input id="contract" name="contract" inputmode="decimal" value="${з('contract')}" placeholder="0 - не требуется"></div>
    </div>
    <div><label for="url">Ссылка на закупку на площадке</label><input id="url" name="url" maxlength="500" value="${з('url')}" placeholder="https://..."></div>
    <p class="small muted" style="margin:0">Обеспечения не указаны - в расчёте останутся пустыми, уточните в документации закупки. Условия оплаты, приёмки и штрафы сервис прочитает из проекта договора сам.</p>
  </div>
  <p><button class="btn"${д.можноСчитать === false ? ' disabled' : ''}>Рассчитать</button></p>
</form>`;
  return кабинет({ заголовок: 'Расчёт по документам', тело, пользователь, активный: 'загрузка' });
}

function поставщики({ пользователь, список, пометки, п = {}, тендеры = [], ниша = null }) {
  const объект = Object.fromEntries(тендеры.map((т) => [т.номер, т.объект]));
  const вид = п.mark || '';
  const отбор = список.filter((с) => {
    const м = (пометки[с.url] || {}).mark || '';
    if (вид === 'работаю' || вид === 'не подходит') return м === вид;
    if (вид === '') return м !== 'не подходит';
    return true;
  });
  const ссылка = (u) => (/^https?:\/\//i.test(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer nofollow">${esc(u.replace(/^https?:\/\/(www\.)?/i, '').slice(0, 40))}</a>` : '');
  const сел = (з, т) => `<option value="${з}"${вид === з ? ' selected' : ''}>${т}</option>`;
  const строки = отбор.map((с) => {
    const м = пометки[с.url] || {};
    const опц = (з, т) => `<option value="${з}"${м.mark === з ? ' selected' : ''}>${т}</option>`;
    return `<div class="card stack">
      <div><b>${esc(с.имя || 'поставщик')}</b> ${с.регион ? `<span class="muted small">· ${esc(с.регион)}</span>` : ''}</div>
      <div class="small">${esc(с.позиция)} <span class="muted">· закупка «${esc((объект[с.закупка] || с.закупка).slice(0, 60))}»</span></div>
      <div class="small">${с.цена !== null ? `<b>${деньги(с.цена)}</b>${с.единица ? ` за ${esc(с.единица)}` : ''} · ` : 'цены нет · '}${ссылка(с.url)}${с.телефон ? ` · ${esc(с.телефон)}` : ''} <span class="muted">· найден ${esc(дата(с.когда))}</span></div>
      <form method="post" action="/app/suppliers/mark" class="grid c2">${скрытое(пользователь.csrf)}<input type="hidden" name="url" value="${esc(с.url)}">
        <select name="mark">${опц('', 'Без пометки')}${опц('работаю', 'Работаю с ним')}${опц('не подходит', 'Не подходит')}</select>
        <input type="text" name="note" maxlength="1000" value="${esc(м.note || '')}" placeholder="Заметка">
        <button class="btn small secondary">Сохранить</button></form>
    </div>`;
  }).join('');
  // Поставщики по нише - собраны заранее при внедрении (24.10.2026); с 30.10 -
  // поставщики ниши в целом, их прайсы скачиваются и обновляются раз в неделю.
  const компании = (ниша && ниша.ok && ниша.поставщики) || [];
  const блокКомпаний = компании.length ? `<details><summary><b>Поставщики и подрядчики ниши</b> <span class="muted small">· ${esc(компании.length)}, с прайсом ${esc(компании.filter((к) => !к.прайсЗакрыт).length)}</span></summary>
    ${компании.map((к) => `<div class="small" style="margin:6px 0 0 12px"><b>${esc(к.имя)}</b>${к.регион ? ` · ${esc(к.регион)}` : ''} · ${ссылка(к.сайт)}${к.телефон ? ` · ${esc(к.телефон)}` : ''} · ${к.прайсЗакрыт ? 'прайс закрыт - запрашивается' : `прайс: ${esc(к.позиций)} позиций, обновляется раз в неделю`}</div>`).join('')}</details>` : '';
  const блокНиши = ниша && ниша.ok && (ниша.товары || []).length ? `<div class="card stack" style="margin-bottom:16px"><h2 style="margin:0">По вашей нише</h2>
  <p class="small muted" style="margin:0">Самые частые позиции в закупках вашей ленты и цены по ним у поставщиков ниши. Собрано ${esc(дата(ниша.когда))}.</p>
  ${блокКомпаний}
  ${ниша.товары.map((т) => `<details><summary><b>${esc(т.товар)}</b> <span class="muted small">· в ${esc(т.закупок)} закупках · поставщиков ${esc((т.поставщики || []).length)}</span></summary>
    ${(т.поставщики || []).map((с) => `<div class="small" style="margin:6px 0 0 12px"><b>${esc(с.name || 'поставщик')}</b>${с.region ? ` · ${esc(с.region)}` : ''} · ${с.price !== null && с.price !== undefined ? `${деньги(с.price)}${с.unit ? ` за ${esc(с.unit)}` : ''}` : 'цены на странице нет'} · ${ссылка(с.url)}${с.phone ? ` · ${esc(с.phone)}` : ''}</div>`).join('') || '<div class="small muted" style="margin:6px 0 0 12px">поставщиков с проверяемой ссылкой не найдено</div>'}</details>`).join('')}
  </div>` : '';
  const тело = `<h1>Поставщики</h1>
${блокНиши}
<p class="muted">Все поставщики из ваших расчётов: что продают, цена, ссылка на страницу и контакты.</p>
<form method="get" action="/app/suppliers" class="card" style="margin-bottom:12px"><select name="mark">${сел('', 'Все, кроме «не подходит»')}${сел('работаю', 'Работаю с ним')}${сел('не подходит', 'Не подходит')}${сел('all', 'Все')}</select> <button class="btn small">Показать</button></form>
<div class="list">${строки || '<div class="card empty">Поставщиков пока нет: они появляются после расчётов с поиском поставщиков.</div>'}</div>`;
  return кабинет({ заголовок: 'Поставщики', тело, пользователь, активный: 'поставщики' });
}

/** Аналитика ниши: что факт, что расчёт - подписано на странице. */
function ниша({ пользователь, отчёт }) {
  const р = отчёт || {};
  const пр = (x) => (x === null || x === undefined ? '—' : `${String(x).replace('.', ',')}%`);
  // Цена товара - с копейками: 295,39 против 330 решает вывод, рубли его прячут.
  const деньги = (x) => (typeof x !== 'number' ? '—' : `${x.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ₽`);
  let тело;
  if (!р.ok) {
    тело = `<h1>Аналитика ниши</h1><div class="card stack"><p style="margin:0">${esc(р.сбой || 'Отчёт не собран.')}</p>
      <p class="small muted" style="margin:0">Для отчёта нужен ваш прайс: загрузите его на странице <a href="/app/price">«Мой прайс»</a>.</p></div>`;
  } else {
    const п = р.падение || {};
    const класс = (т) => (/^заходить/.test(т.вывод) ? 'ok' : /^на грани/.test(т.вывод) ? 'warn' : /^мало данных|не измерено/.test(т.вывод) ? '' : 'bad');
    const строки = (р.товары || []).map((т) => `<tr>
      <td>${esc(т.товар)}${т.единица ? ` <span class="muted small">(${esc(т.единица)})</span>` : ''}</td>
      <td class="nowrap">${esc(т.закупок)}</td>
      <td class="nowrap">${деньги(т.ценаЗаказчика)}</td>
      <td class="nowrap">${т.ожидаемаяЦенаПобеды === null ? '—' : деньги(т.ожидаемаяЦенаПобеды)}</td>
      <td class="nowrap">${деньги(т.вашаЦена)} <span class="muted small">→ ${деньги(т.безубыточная)}</span></td>
      <td><span class="tag ${класс(т)}" style="margin:0">${esc(т.вывод)}</span></td></tr>`).join('');
    тело = `<h1>Аналитика ниши</h1>
<div class="kpis">
  <div class="card kpi"><div class="small muted">Обычное падение цены на торгах</div><div class="v">${пр(п.медиана)}</div><div class="small muted">у половины закупок ${пр(п.q1)} - ${пр(п.q3)}, закупок ${esc(п.n || 0)}</div></div>
  <div class="card kpi"><div class="small muted">Участников обычно</div><div class="v">${р.участников === null || р.участников === undefined ? '—' : esc(р.участников)}</div></div>
  <div class="card kpi"><div class="small muted">Товаров из прайса найдено в закупках</div><div class="v">${esc(р.найденоТоваров)} из ${esc(р.строкПрайса)}</div></div>
</div>
${(п.предупреждения || []).length ? `<div class="alert info">${п.предупреждения.map(esc).join('. ')}</div>` : ''}
<div class="card" style="margin-top:16px"><div class="scroll"><table class="t">
  <tr><th>Товар из вашего прайса</th><th>Закупок</th><th>Цена заказчика</th><th>Ожидаемая цена победы</th><th>Ваша цена → безубыточная</th><th>Вывод</th></tr>
  ${строки || '<tr><td colspan="6" class="muted">Товары вашего прайса в разобранных закупках пока не встретились.</td></tr>'}
</table></div></div>
<p class="small muted" style="margin-top:12px">Цена заказчика - по обоснованиям начальной цены разобранных закупок, где есть этот товар (медиана). Падение цены и участники - по протоколам прошлых закупок тех же групп товаров, без закупок с единственной заявкой. Ожидаемая цена победы - расчёт: цена заказчика минус обычное падение; цену победы портал публикует на закупку целиком, а не на товар. Безубыточная - ваша цена с доставкой ${пр(Math.round(р.доставка * 1000) / 10)} и налогом ${пр(Math.round(р.налог * 1000) / 10)} (из ваших настроек, иначе 8% и 6%).</p>`;
  }
  тело += `<div class="card stack" style="margin-top:16px"><h2 style="margin:0">Разбор прошлого тендера</h2>
  <p class="small muted" style="margin:0">Номер завершённой закупки: посчитаем её заново по вашим ценам и покажем, сколько вы заработали бы при цене победителя и какие были условия контракта. Около 1-3 минут.</p>
  <form method="post" action="/app/past" class="inline">${скрытое(пользователь.csrf)}<input name="number" inputmode="numeric" placeholder="0373200001226000904" required pattern="[0-9 ]{11,25}"> <button class="btn small">Разобрать</button></form></div>`;
  return кабинет({ заголовок: 'Аналитика ниши', тело, пользователь, активный: 'ниша' });
}

/** Итог разбора прошлого тендера. */
function прошлый({ пользователь, р }) {
  const д = (x) => (typeof x !== 'number' ? '—' : `${String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ₽`);
  let тело;
  if (!р || !р.ok) {
    тело = `<h1>Разбор прошлого тендера</h1><div class="card stack"><p style="margin:0">${esc((р && р.сбой) || 'Разбор не получился.')}</p><p style="margin:0"><a href="/app/niche">← Аналитика ниши</a></p></div>`;
  } else {
    const п = р.протокол || {};
    const у = р.условия || {};
    const усл = [
      у.аванс ? (у.аванс.есть ? `аванс ${у.аванс.процент}%` : 'аванс не предусмотрен') : '',
      у.оплата ? `оплата в течение ${у.оплата.дней} ${у.оплата.вид || ''} дн.` : '',
      у.штраф ? 'штраф по шкале ПП № 1042' : '', у.пеня ? `пеня: ${у.пеня.доля}` : '',
      у.гарантия ? (у.гарантия.есть ? `обеспечение гарантии ${у.гарантия.процент}%` : 'обеспечение гарантии не требуется') : ''
    ].filter(Boolean);
    тело = `<p class="small"><a href="/app/niche">← Аналитика ниши</a></p><h1>Разбор прошлого тендера</h1>
<div class="card stack"><div class="mono small muted">№ ${esc(р.номер)}</div><h2 style="margin:0">${esc(р.объект || 'объект не указан')}</h2>
  <p style="margin:0"><b>${esc(р.вывод)}</b></p></div>
<div class="kpis" style="margin-top:16px">
  <div class="card kpi"><div class="small muted">Начальная цена</div><div class="v">${д(р.нмцк)}</div></div>
  <div class="card kpi"><div class="small muted">Цена победы</div><div class="v">${п.ценаПобеды ? д(п.ценаПобеды) : '—'}</div><div class="small muted">${п.ценаПобеды ? `падение ${String(п.снижение).replace('.', ',')}%${п.участников ? `, участников ${п.участников}` : ''}${п.единственнаяЗаявка ? ', единственная заявка' : ''}` : esc(п.причина || '')}</div></div>
  <div class="card kpi"><div class="small muted">Закупка по вашим ценам</div><div class="v">${д(р.закупка)}</div><div class="small muted">ваши цены у ${esc(р.сЗакупочной)} из ${esc(р.позиций)} позиций</div></div>
  <div class="card kpi"><div class="small muted">Ваша безубыточная цена</div><div class="v">${д(р.безубыточность)}</div></div>
</div>
${усл.length ? `<div class="card stack" style="margin-top:16px"><h2 style="margin:0">Условия контракта</h2><p style="margin:0">${усл.map(esc).join(' · ')}</p></div>` : ''}
<p class="small muted"><a href="${esc(р.ссылка)}" target="_blank" rel="noopener noreferrer">Закупка на портале</a></p>`;
  }
  return кабинет({ заголовок: 'Разбор прошлого тендера', тело, пользователь, активный: 'ниша' });
}

const СТАТУС_ПЛАТЕЖА = { 'создан': 'создан', 'ждёт оплаты': 'ждёт оплаты', 'оплачен': 'оплачен', 'отменён': 'не оплачен', 'сбой': 'не создан' };

function тариф({ пользователь, д, платежи = [], подключена, сообщ = '', ошибка = '', ссылка = '' }) {
  const { ТАРИФЫ, ВНЕДРЕНИЕ, ВНЕДРЕНИЕ_ПУНКТЫ, нуженВнедрение, суммаОплаты } = require('./tariffs');
  // paid_until компании: у действующего тарифа - д.до, у истёкшего - д.истёк.
  const внедрение = нуженВнедрение({ paid_until: д.до || д.истёк || null }, платежи);
  const сейчас = д.активен
    ? `<p>Тариф <b>«${esc(д.имя)}»</b> оплачен до <b>${esc(дата(д.до))}</b>.</p>`
    : `<p>${д.истёк ? `Тариф закончился ${esc(дата(д.истёк))}. ` : ''}Сейчас пробный период: осталось бесплатных расчётов ${esc(д.осталось)}.</p>`;
  // Карточки - как на публичной странице тарифов (владелец 28.10.2026).
  const карточки = Object.values(ТАРИФЫ).map((т) => `<div class="card plan${т.выделен ? ' featured' : ''}" id="plan-${esc(т.код)}">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><h3 style="margin:0">${esc(т.имя)}</h3>${д.активен && д.код === т.код ? '<span class="badge">ваш тариф</span>' : т.метка ? `<span class="badge">${esc(т.метка)}</span>` : ''}</div>
    <div class="price">${деньги(т.цена)}<span class="small muted"> / мес</span></div>
    <ul>${т.пункты.map((п) => `<li>${esc(п)}</li>`).join('')}${т.вРазработке.map((п) => `<li class="dev">${esc(п)} - в разработке</li>`).join('')}</ul>
    ${внедрение ? `<p class="small muted" style="margin:0">Первая оплата: ${деньги(т.цена)} + внедрение ${деньги(ВНЕДРЕНИЕ)} = <b>${деньги(суммаОплаты(т, true))}</b></p>` : ''}
    ${подключена ? `<form method="post" action="/app/billing/pay">${скрытое(пользователь.csrf)}<input type="hidden" name="tariff" value="${esc(т.код)}">
      <button class="btn${т.выделен ? '' : ' secondary'}" style="width:100%">${д.активен && д.код === т.код ? 'Продлить' : `Оплатить ${деньги(суммаОплаты(т, внедрение))}`}</button></form>`
    : `<form method="post" action="/app/billing/request">${скрытое(пользователь.csrf)}<input type="hidden" name="tariff" value="${esc(т.код)}">
      <button class="btn${т.выделен ? '' : ' secondary'}" style="width:100%">Оставить заявку</button></form>`}
  </div>`).join('');
  // Плашка внедрения слева - как на публичной странице, тексты короче.
  const плашкаВнедрения = внедрение ? `<aside class="setup">
      <div class="eyebrow">Внедрение</div>
      <div class="price">${деньги(ВНЕДРЕНИЕ)}<span class="small"> разово</span></div>
      <h3 style="margin:0">Первую неделю работаем параллельно с вами</h3>
${ВНЕДРЕНИЕ_ПУНКТЫ.map((п, i) => `      <div class="drow"><h3 style="margin:0">${i + 1}. ${esc(п.заголовок)}</h3><p class="muted" style="margin:4px 0 0">${esc(п.коротко || п.текст)}</p></div>`).join('\n')}
      <p class="small muted" style="margin:0">Оплачивается один раз, вместе с первым месяцем тарифа.</p>
    </aside>` : '';
  const история = платежи.length ? `<div class="scroll"><table class="t"><tr><th>Дата</th><th>Тариф</th><th>Сумма</th><th>Статус</th></tr>${платежи.map((п) =>
    `<tr><td class="nowrap">${esc(дата(п.created))}</td><td>${esc((ТАРИФЫ[п.tariff] || {}).имя || п.tariff)}</td><td class="nowrap">${деньги(п.amount)}</td><td>${esc(СТАТУС_ПЛАТЕЖА[п.status] || п.status)}</td></tr>`).join('')}</table></div>` : '';
  const тело = `<h1>Тариф</h1>${сообщение('ok', сообщ)}${сообщение('bad', ошибка)}
${ссылка ? `<div class="card stack" style="margin-bottom:16px"><p style="margin:0">Платёж создан. Оплата проходит на странице ЮKassa: карта, СБП или ЮMoney.</p><p style="margin:0"><a class="btn" href="${esc(ссылка)}" rel="noopener noreferrer">Перейти к оплате</a></p></div>` : ''}
<div class="card" style="margin-bottom:16px">${сейчас}
  <p class="small muted" style="margin:0">Оплата на 30 дней. Продление добавляет 30 дней к концу текущего срока, при смене тарифа оставшиеся дни сохраняются. Автосписаний нет: каждый месяц вы оплачиваете сами.</p></div>
${подключена ? '' : '<div class="alert info">Оплата картой на сайте подключается. Оставьте заявку на нужный тариф: выставим счёт и включим тариф в течение рабочего дня.</div>'}
<div class="plans-row">${плашкаВнедрения}<div class="grid c3">${карточки}</div></div>
${история ? `<div class="card" style="margin-top:16px"><h2>Платежи</h2>${история}</div>` : ''}`;
  return кабинет({ заголовок: 'Тариф', тело, пользователь, активный: 'тариф' });
}

function блокTelegram(пользователь, tg, кодTg) {
  if (!tg) return '';
  if (кодTg) {
    const ссылка = tg.бот ? `https://t.me/${encodeURIComponent(tg.бот)}?start=${encodeURIComponent(кодTg)}` : '';
    return `<div class="card stack"><h2 style="margin:0">Telegram</h2>
      ${ссылка ? `<p style="margin:0"><a class="btn" href="${esc(ссылка)}" target="_blank" rel="noopener noreferrer">Открыть бота и подключить</a></p>
      <p class="small muted" style="margin:0">В Telegram нажмите «Запустить». Если кнопка не сработала, отправьте боту сообщение:</p>` : '<p style="margin:0">Отправьте боту KarginTech сообщение:</p>'}
      <p class="mono" style="margin:0;font-size:1.1rem">/start ${esc(кодTg)}</p>
      <p class="small muted" style="margin:0">Код действует 30 минут и подходит один раз. После подключения обновите эту страницу.</p></div>`;
  }
  if (tg.чат) {
    return `<div class="card stack"><h2 style="margin:0">Telegram</h2><p style="margin:0">Подключён. Сюда приходят новые тендеры и готовые расчёты.</p>
      <form method="post" action="/app/telegram/unlink">${скрытое(пользователь.csrf)}<button class="btn secondary small">Отключить</button></form></div>`;
  }
  return `<div class="card stack"><h2 style="margin:0">Telegram</h2><p style="margin:0">Новые тендеры и готовые расчёты могут приходить в Telegram.</p>
    <form method="post" action="/app/telegram/link">${скрытое(пользователь.csrf)}<button class="btn small">Подключить Telegram</button></form></div>`;
}

function профиль({ пользователь, компания, д = null, tg = null, кодTg = '', сообщ = '', ошибка = '' }) {
  const тело = `<h1>Профиль</h1>${сообщение('ok', сообщ)}${сообщение('bad', ошибка)}
<div class="grid c2">
  <div class="card"><dl class="kv">
    <dt>Почта</dt><dd>${esc(пользователь.email)}</dd>
    <dt>Компания</dt><dd>${esc(компания.name)}</dd>
    <dt>Тариф</dt><dd>${д ? (д.активен ? `${esc(д.имя)} до ${esc(дата(д.до))}` : `пробный, осталось расчётов ${esc(д.осталось)}`) : ''} · <a href="/app/billing">изменить</a></dd>
  </dl></div>
  <form class="card" method="post" action="/app/profile">${скрытое(пользователь.csrf)}
    <h2>Смена пароля</h2>
    <label for="o">Текущий пароль</label><input id="o" type="password" name="current" autocomplete="current-password" required>
    <label for="n">Новый пароль</label><input id="n" type="password" name="password" autocomplete="new-password" minlength="10" required>
    <div class="hint">Не короче 10 знаков. После смены другие ваши входы на сайт закроются.</div>
    <p style="margin-top:14px"><button class="btn">Сменить пароль</button></p>
  </form>
  ${блокTelegram(пользователь, tg, кодTg)}
</div>`;
  return кабинет({ заголовок: 'Профиль', тело, пользователь, активный: 'профиль' });
}

module.exports = { онбординг, лента, карточка, расчёт, история, настройки, прайс, профиль, поставщики, загрузка, ниша, прошлый, тариф, вердикт, отобратьЛенту, способ, запросФильтра, меткиИзменений, текстОбеспечения, упорядочитьПоВыгоде };
