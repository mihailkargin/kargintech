// KarginTech — единственный скрипт сайта. Встроенные скрипты запрещены
// заголовком безопасности (CSP), поэтому всё поведение — здесь.
(function () {
  // Кнопка «показать пароль» (глаз) у каждого поля пароля - просьба владельца
  // 25.10.2026. Без скрипта поле остаётся обычным.
  var пароли = document.querySelectorAll('input[type="password"]');
  for (var п = 0; п < пароли.length; п++) {
    (function (поле) {
      var обёртка = document.createElement('span');
      обёртка.className = 'pw-wrap';
      поле.parentNode.insertBefore(обёртка, поле);
      обёртка.appendChild(поле);
      var кн = document.createElement('button');
      кн.type = 'button';
      кн.className = 'pw-eye';
      кн.setAttribute('aria-label', 'Показать пароль');
      кн.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
      кн.addEventListener('click', function () {
        var видно = поле.type === 'text';
        поле.type = видно ? 'password' : 'text';
        кн.setAttribute('aria-label', видно ? 'Показать пароль' : 'Скрыть пароль');
        кн.classList.toggle('on', !видно);
        поле.focus();
      });
      обёртка.appendChild(кн);
    })(пароли[п]);
  }

  // Суммы в полях цен пишутся сами с отступами на тысячах: набрал 5000000 —
  // видишь 5 000 000 (просьба владельца 16.11.2026: «не человек пишет
  // пробелом»). Только целые рубли; дробная часть этим полям не нужна.
  // Без скрипта поле остаётся обычным, сервер сам ест и пробелы, и запятые.
  var деньгиПоля = document.querySelectorAll('input[name="from"], input[name="to"], input[name="nmck"]');
  function форматСуммы(значение) {
    var цифры = String(значение || '').replace(/[^\d]/g, '').slice(0, 15);
    var out = '';
    for (var и = 0; и < цифры.length; и++) {
      if (и > 0 && (цифры.length - и) % 3 === 0) out += ' ';
      out += цифры[и];
    }
    return out;
  }
  for (var д = 0; д < деньгиПоля.length; д++) {
    (function (поле) {
      поле.setAttribute('inputmode', 'numeric');
      поле.addEventListener('input', function () {
        var было = поле.value;
        var стало = форматСуммы(было);
        if (стало !== было) {
          поле.value = стало;
          // Курсор — в конец; выделение текста при вводе суммы не нужно.
          if (поле.setSelectionRange) поле.setSelectionRange(стало.length, стало.length);
        }
      });
      поле.value = форматСуммы(поле.value);
    })(деньгиПоля[д]);
  }

  // Страница расчёта и ленты, пока идёт работа, обновляется сама.
  var ждать = document.querySelector('[data-refresh]');
  if (ждать) setTimeout(function () { location.reload(); }, (Number(ждать.getAttribute('data-refresh')) || 15) * 1000);

  // На телефоне фильтры свёрнуты: до ленты не нужно листать полсотни
  // галочек. Без скрипта они остаются открытыми - ничего не теряется.
  if (window.matchMedia && window.matchMedia('(max-width: 759px)').matches) {
    var свернуть = document.querySelectorAll('details[data-mobile-close]');
    for (var i = 0; i < свернуть.length; i++) свернуть[i].open = false;
  }

  // Лента: место прокрутки запоминается для этих же фильтров. Вернулся из
  // карточки тендера, нажал «Тендеры» в меню, отметил «В избранное» -
  // лента открывается там, где остановился, а не с начала.
  if (location.pathname !== '/app') return;
  var ключ = 'feed-scroll:' + location.search.replace(/[?&]ok=[^&]*/g, '');
  var хранилище = null;
  try { хранилище = window.sessionStorage; хранилище.getItem('x'); } catch (e) { хранилище = null; }
  if (!хранилище) return;
  try { history.scrollRestoration = 'manual'; } catch (e) { /* старый браузер */ }
  var было = Number(хранилище.getItem(ключ));
  if (было > 0) window.scrollTo(0, было);
  var таймер = null;
  function запомнить() { try { хранилище.setItem(ключ, String(Math.round(window.scrollY))); } catch (e) { /* нет места */ } }
  window.addEventListener('scroll', function () { clearTimeout(таймер); таймер = setTimeout(запомнить, 150); }, { passive: true });
  window.addEventListener('pagehide', запомнить);
})();
