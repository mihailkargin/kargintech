/**
 * Сопоставление текущей выдачи с тем, что уже видели.
 *
 * Чистая функция: состояние приходит аргументом и возвращается новым значением.
 * Где оно хранится (файл, база, статические данные n8n) решается на уровне обвязки.
 *
 * Задача не только «не показывать одно и то же дважды». Не менее важно заметить
 * изменения в уже известном тендере: сдвинутый срок подачи или изменённая НМЦК —
 * это то, из-за чего клиент может сорвать подачу, если не узнает вовремя.
 */

/** Поля, изменение которых клиент обязан увидеть. */
const TRACKED = [
  { field: 'deadline', label: 'срок подачи' },
  { field: 'price', label: 'НМЦК' },
  { field: 'status', label: 'статус' }
];

const dayMs = 24 * 60 * 60 * 1000;
const isoDay = (d) => d.toISOString().slice(0, 10);

/**
 * @param {Array<object>} tenders карточки текущего прогона
 * @param {object} state предыдущее состояние, ключ — реестровый номер
 * @param {{now?: Date, keepDays?: number}} options
 * @returns {{fresh: Array, updated: Array, unchanged: Array, nextState: object, prunedCount: number}}
 */
function diffAgainstState(tenders, state = {}, options = {}) {
  const now = options.now || new Date();
  const keepDays = options.keepDays ?? 60;
  const today = isoDay(now);

  const nextState = { ...state };
  const fresh = [];
  const updated = [];
  const unchanged = [];

  for (const t of tenders) {
    const previous = state[t.number];

    if (!previous) {
      fresh.push(t);
      nextState[t.number] = {
        deadline: t.deadline,
        price: t.price,
        status: t.status,
        firstSeen: today,
        lastSeen: today
      };
      continue;
    }

    const changes = [];
    for (const { field, label } of TRACKED) {
      if (previous[field] !== t[field]) {
        changes.push({ field, label, from: previous[field], to: t[field] });
      }
    }

    nextState[t.number] = {
      deadline: t.deadline,
      price: t.price,
      status: t.status,
      firstSeen: previous.firstSeen || today,
      lastSeen: today
    };

    if (changes.length) updated.push({ ...t, changes, firstSeen: previous.firstSeen });
    else unchanged.push(t);
  }

  // Чистка состояния, чтобы оно не росло бесконечно.
  // Удаляем только заведомо неактуальное: тендеры, срок подачи которых прошёл
  // давно. Отсутствие тендера в текущей выдаче поводом для удаления НЕ является —
  // он мог просто уйти на другую страницу, и забыв его, мы покажем его снова
  // как новый.
  let prunedCount = 0;
  const cutoff = isoDay(new Date(now.getTime() - keepDays * dayMs));
  for (const [number, entry] of Object.entries(nextState)) {
    if (entry.lastSeen === today) continue;
    const reference = entry.deadline || entry.lastSeen;
    if (reference && reference < cutoff) {
      delete nextState[number];
      prunedCount++;
    }
  }

  return { fresh, updated, unchanged, nextState, prunedCount };
}

/** Человекочитаемое описание изменений для уведомления. */
function describeChanges(changes) {
  return changes
    .map(c => `${c.label}: ${c.from === null ? 'не указан' : c.from} → ${c.to === null ? 'не указан' : c.to}`)
    .join('; ');
}

module.exports = { diffAgainstState, describeChanges, TRACKED };
