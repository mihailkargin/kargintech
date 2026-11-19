/**
 * Данные для аналитики ниши (src/niche-report.js) - 24.10.2026.
 *
 * Позиции прошлых закупок с ценами заказчика - из следов расчётов
 * /data/state/verify-<номер>.json (публичные документы закупки; цен клиента в
 * следе нет по устройству), группа товара - из архива закупок, падение цены -
 * из протоколов архива. Прайс - только самого клиента, тем же загрузчиком с
 * запиранием пути, что в расчёте. На портал не ходит.
 */
const fs = require('fs');
const path = require('path');
const { аналитикаНиши } = require(path.join(__dirname, '..', 'src', 'niche-report'));
const { загрузитьПрайс } = require('./estimate-run');
const { настройкиКлиента, общиеНастройки } = require('./settings');

const КЭШ_МС = 10 * 60 * 1000;
let кэшЗакупок = null;
const кэшОтчётов = new Map();

/** Позиции всех следов расчётов с группами ОКПД2 - общие для всех клиентов, кэш 10 минут. */
function закупкиИзСледов(каталог) {
  if (кэшЗакупок && Date.now() - кэшЗакупок.когда < КЭШ_МС) return кэшЗакупок.данные;
  const группы = new Map();
  try {
    const { DatabaseSync } = require('node:sqlite');
    const б = new DatabaseSync(path.join(каталог, 'archive.db'), { readOnly: true });
    for (const р of б.prepare('SELECT number, okpd FROM tenders').all()) if (р.okpd && р.okpd !== '00.00') группы.set(р.number, [р.okpd]);
    for (const р of б.prepare('SELECT number, data FROM parsed').all()) {
      try { const г = JSON.parse(р.data || '{}').группыОкпд2; if (г && г.length) группы.set(р.number, г); } catch (e) { /* битая запись */ }
    }
    б.close();
  } catch (e) { /* архива нет - группы неизвестны */ }
  const данные = [];
  for (const ф of fs.readdirSync(каталог).filter((x) => /^verify-\d+\.json$/.test(x))) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(каталог, ф), 'utf8'));
      const позиции = (j.позиции || []).filter((п) => п && п.name && (п.prices || []).length);
      if (позиции.length) данные.push({ номер: j.номер, группы: группы.get(String(j.номер)) || [], позиции });
    } catch (e) { /* недописанный след */ }
  }
  кэшЗакупок = { когда: Date.now(), данные };
  return данные;
}

function протоколыАрхива(каталог) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const б = new DatabaseSync(path.join(каталог, 'archive.db'), { readOnly: true });
    const р = б.prepare('SELECT data FROM protocols').all().map((x) => { try { return JSON.parse(x.data || '{}'); } catch (e) { return null; } }).filter(Boolean);
    б.close();
    return р;
  } catch (e) { return []; }
}

/** Отчёт по клиенту сайта. */
function отчётНиши(клиент) {
  const ид = String(клиент || '');
  if (!/^site-[a-z0-9]{6,40}$/.test(ид)) return { ok: false, сбой: 'не клиент сайта' };
  const был = кэшОтчётов.get(ид);
  if (был && Date.now() - был.когда < КЭШ_МС) return был.отчёт;
  const н = настройкиКлиента(ид);
  if (!н) return { ok: false, сбой: 'настроек клиента нет' };
  const журнал = []; const проблемы = [];
  const прайс = загрузитьПрайс(н, журнал, проблемы);
  const каталог = общиеНастройки().каталогДанных || '/data/state';
  const эк = н.economics || {};
  const р = аналитикаНиши({
    прайс, закупки: закупкиИзСледов(каталог), протоколы: протоколыАрхива(каталог),
    налог: typeof эк.taxRate === 'number' ? эк.taxRate : undefined,
    доставка: typeof эк.logisticsMaxPct === 'number' ? эк.logisticsMaxPct / 100 : undefined
  });
  const отчёт = { ...р, ...(р.ok ? {} : { сбой: р.причина || проблемы[0] }), когда: new Date().toISOString() };
  кэшОтчётов.set(ид, { когда: Date.now(), отчёт });
  return отчёт;
}

module.exports = { отчётНиши };
