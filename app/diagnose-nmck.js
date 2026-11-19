/**
 * ДИАГНОСТИКА РАЗБОРА ТАБЛИЦЫ ПОЗИЦИЙ.
 *
 * Запуск на сервере:
 *   docker compose exec -T app node app/diagnose-nmck.js --number 0373200638526000056
 *   docker compose exec -T app node app/diagnose-nmck.js --number <номер> --rows 60
 *
 * ЗАЧЕМ. 12.10.2026 разбор обоснования НМЦК выдал 172 «позиции», которые
 * оказались подписями колонок таблицы. Защита от выдачи такого клиенту
 * поставлена, но она лечит следствие: расчёта по этой закупке всё равно нет.
 * Чтобы починить сам разбор, надо увидеть, как свёрстана таблица, а портал
 * мне самому недоступен — смотреть страницы можно только с сервера.
 *
 * Поэтому команда печатает то, на что смотрит разбор: строки документа с
 * ВИДИМЫМИ табуляциями, найденную шапку, сопоставление колонок и первые
 * разобранные позиции. По этому выводу правка делается по факту, а не
 * по догадке о вёрстке.
 *
 * Печатается кусок документа, а не файл целиком: нужен вид таблицы, а не
 * всё содержимое. Предел строк задаётся ключом `--rows`.
 */
const path = require('path');
const SRC = path.join(__dirname, '..', 'src');
const { parseNoticePage } = require(path.join(SRC, 'notice-page'));
const { parseDocumentsPage, selectForExtraction } = require(path.join(SRC, 'docs-page'));
const { extractText, ROUTE } = require(path.join(SRC, 'extract-text'));
const { parseNmckTable, findHeader } = require(path.join(SRC, 'nmck-table'));
const { подписьКолонки, сверитьПозиции, годностьРазбора, ИСХОДЫ } =
  require(path.join(SRC, 'verify'));
const { documentsUrls } = require(path.join(SRC, 'parser'));
const { взять, взятьТекст } = require('./http');
const { строкаВерсии } = require('./fingerprint');
const { общиеНастройки } = require('./settings');

function ключ(имя, поУмолчанию = null) {
  const i = process.argv.indexOf('--' + имя);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : поУмолчанию;
}

/** Табуляции делаются видимыми: без этого «две колонки» и «одна колонка с
 *  пробелами» в выводе выглядят одинаково, а разбор различает только их. */
function видимо(строка) {
  return строка.replace(/\t/g, '«TAB»').replace(/ /g, '«NBSP»');
}

async function main() {
  console.log(строкаВерсии());

  const номер = ключ('number');
  const строкПредел = Number(ключ('rows', '50')) || 50;
  if (!номер) {
    console.log('Нужен номер закупки: --number 0373200638526000056');
    process.exit(1);
  }

  const настройки = общиеНастройки();
  const ссылка = 'https://zakupki.gov.ru/epz/order/notice/ea20/view/common-info.html'
    + `?regNumber=${номер}`;

  console.log(`закупка ${номер}`);
  const карточка = await взять(ссылка, { мс: 60000 });
  if (!карточка.ok) {
    console.log(`карточка недоступна: код ${карточка.код} ${карточка.подсказка || ''}`);
    process.exit(1);
  }
  const tender = parseNoticePage(карточка.тело.toString('utf8'), ссылка);

  // Страница документации — тем же путём, что в бою: двумя кандидатами.
  let док = null;
  for (const адрес of documentsUrls(tender)) {
    const r = await взятьТекст(адрес, 60000);
    if (!r.ok) continue;
    const разбор = parseDocumentsPage(r.тело, адрес);
    if (разбор.files && разбор.files.length) { док = разбор; break; }
  }
  if (!док) {
    console.log('страница документации не открылась ни по одному адресу');
    process.exit(1);
  }

  const { selected } = selectForExtraction(док.files, настройки.документовМаксимум || 25);
  console.log(`файлов на странице ${док.files.length}, к разбору ${selected.length}`);

  for (const f of selected) {
    const файл = await взять(f.url, { мс: 120000 });
    if (!файл.ok) { console.log(`  «${f.name}»: не скачался`); continue; }

    let r = extractText(файл.тело, f.name);
    if (r.route === ROUTE.FILE) { console.log(`  «${f.name}»: PDF, кодом не читается`); continue; }
    if (r.needsConversion) { console.log(`  «${f.name}»: нужен конвертер, пропускаю`); continue; }
    if (!r.ok || !r.text) { console.log(`  «${f.name}»: не прочитан — ${r.issue || '—'}`); continue; }

    const разбор = parseNmckTable(r.text);
    if (!разбор.positions.length) {
      console.log(`  «${f.name}» (${r.text.length} знаков): позиций не найдено`);
      continue;
    }

    console.log('');
    console.log('='.repeat(70));
    console.log(`ФАЙЛ «${f.name}» (${f.kind || 'назначение не определено'}), `
      + `${r.text.length} знаков, позиций разобрано ${разбор.positions.length}`);
    console.log('='.repeat(70));

    // --- что разбор принял за шапку ------------------------------------
    const шапка = findHeader(r.text.split(/\r?\n/).map((с) => с.split('\t')));
    console.log('');
    if (разбор.перевёрнутая) {
      console.log('');
      console.log('--- ВИД ТАБЛИЦЫ: ПЕРЕВЁРНУТАЯ ---');
      console.log('подписи полей стоят в первой ячейке, товар занимает блок строк;');
      console.log('обычная шапка здесь не ищется, сверка идёт по блокам');
    }

    console.log('--- ЧТО ПРИНЯТО ЗА ШАПКУ ---');
    if (!шапка) {
      console.log('шапка не определена');
    } else {
      console.log(`найдена в строке ${шапка.at + 1}, данные с ${шапка.dataFrom + 1}`);
      console.log('  ячейки шапки: ' + видимо((шапка.header || []).join('\t')).slice(0, 300));
      console.log(`  колонка наименования: ${шапка.nameAt}`
        + ` («${(шапка.header || [])[шапка.nameAt] || ''}»)`);
      console.log(`  колонка количества:   ${шапка.qtyAt}`
        + (шапка.qtyAt === -1 ? ' — НЕ НАЙДЕНА, количества у позиций не будет'
          : ` («${(шапка.header || [])[шапка.qtyAt] || ''}»)`));
      console.log(`  колонка единицы:      ${шапка.unitAt}`);
      console.log('  колонки цен:          '
        + ((шапка.priceCols || []).map((c) => `${c.at}:«${c.title}»`).join(', ') || 'нет'));
    }

    // --- вердикт самопроверки -----------------------------------------
    const сверка = сверитьПозиции(разбор.positions, r.text,
      { перевёрнутая: !!разбор.перевёрнутая });
    const годность = годностьРазбора(сверка, разбор.positions);
    console.log('');
    console.log('--- ВЕРДИКТ САМОПРОВЕРКИ ---');
    console.log(`годен: ${годность.годен ? 'да' : 'НЕТ'}, `
      + `подтверждено ${годность.подтверждено} из ${годность.всего}, `
      + `подписей колонок ${годность.подписей}`);
    for (const п of годность.причины) console.log('  причина: ' + п);

    // --- первые разобранные позиции -----------------------------------
    console.log('');
    console.log('--- ПЕРВЫЕ 12 РАЗОБРАННЫХ ПОЗИЦИЙ ---');
    for (const п of разбор.positions.slice(0, 12)) {
      const подпись = подписьКолонки(п.name);
      console.log(`  [${подпись ? 'ПОДПИСЬ КОЛОНКИ' : 'товар?'}] «${String(п.name).replace(/\s+/g, ' ').slice(0, 70)}»`);
      console.log(`      количество: ${п.quantity === null ? 'НЕТ' : п.quantity}`
        + `, ед.: «${п.unit || ''}»`
        + `, цены: ${(п.prices || []).map((c) => c.value).join(', ')}`);
    }

    // --- сам документ, как его видит разбор ----------------------------
    //
    // ГЛАВНАЯ ЧАСТЬ ВЫВОДА. Остальное — что код понял; здесь то, что код
    // читает. Расхождение между этими двумя частями и есть ошибка разбора.
    console.log('');
    console.log(`--- СТРОКИ ДОКУМЕНТА, ПЕРВЫЕ ${строкПредел} (табуляции видимы) ---`);
    const строки = r.text.split(/\r?\n/);
    for (let i = 0; i < Math.min(строкПредел, строки.length); i++) {
      const с = строки[i];
      const колонок = с.split('\t').length;
      console.log(`${String(i + 1).padStart(4)} [${колонок}] ${видимо(с).slice(0, 200)}`);
    }
    if (строки.length > строкПредел) {
      console.log(`     … всего строк ${строки.length}, показано ${строкПредел} `
        + '(больше — ключом --rows)');
    }

    // Разбирать второй файл незачем: нужен тот, где нашлись позиции.
    break;
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('диагностика не выполнена: ' + e.stack);
    process.exit(1);
  });
}
