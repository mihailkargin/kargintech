/**
 * Конвертер старых форматов Microsoft — отдельный сервис.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ. .doc и .xls это 39% приложенных к закупкам файлов
 * (замерено на 26 файлах из четырёх закупок). Прочитать их без LibreOffice
 * нельзя, а поставить LibreOffice внутрь образа n8n невозможно: с 01.10.2026
 * n8n собран как Docker Hardened Image, менеджер пакетов оттуда вырезан.
 * Подробности — в комментарии deploy/Dockerfile.
 *
 * ГЛАВНОЕ ПРАВИЛО ЭТОГО ФАЙЛА. Непрочитанный документ нельзя подменять
 * пустым или частичным. LibreOffice умеет завершаться с кодом 0, не создав
 * файла, и умеет создавать файл без текста — оба случая выглядят как успех.
 * Поэтому результат проверяется трижды: файл создан, он непустой, и он
 * действительно ZIP (DOCX и XLSX всегда начинаются с «PK»). Любая осечка —
 * честная ошибка с причиной, а не тихий пустой ответ.
 *
 * Наружу сервис не смотрит: порт не публикуется, он доступен только другим
 * контейнерам внутри docker-сети. Проверки подлинности здесь поэтому нет —
 * её роль играет сетевая изоляция.
 *
 * Внешних зависимостей нет: только встроенные модули Node.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { conversionCommand, CONVERT_TO, качествоРаспознавания } = require('/opt/tender/extract-text');

const PORT = Number(process.env.PORT || 3000);

/** Больше этого не принимаем. Самый крупный файл в выборке — около 12 МБ. */
const MAX_BYTES = 100 * 1024 * 1024;

/** Сколько ждём LibreOffice. Зависший конвертер не должен держать очередь. */
const TIMEOUT_MS = 180000;

const log = (...parts) => console.log(new Date().toISOString(), ...parts);

/** Расширение из имени файла, без точки, в нижнем регистре. */
function extOf(name) {
  const m = String(name || '').match(/\.([A-Za-z0-9]{1,5})\s*$/);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Читает тело запроса целиком, обрывая слишком большое.
 * Копим в массив и склеиваем один раз: конкатенация в цикле на файле
 * в десятки мегабайт означает десятки лишних копий в памяти.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) {
        reject(new Error(`файл больше допустимого предела ${MAX_BYTES} байт`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Удаляет временный каталог, не роняя обработку, если не вышло. */
function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    log('ВНИМАНИЕ не удалён временный каталог', dir, e.message);
  }
}

function convert(buffer, sourceFormat, цель = null) {
  return new Promise((resolve) => {
    const cmd0 = conversionCommand('x', 'y', sourceFormat, цель);
    const target = cmd0 ? cmd0.target : null;
    if (!target) {
      resolve({ ok: false, status: 400, issue: `формат «${sourceFormat}» конвертеру не нужен или не поддерживается` });
      return;
    }

    // Входной файл кладём под простым латинским именем. Настоящие имена на
    // портале бывают с кириллицей, пробелами и скобками — зависеть от того,
    // как их переварит оболочка и сам LibreOffice, незачем.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-'));
    const inPath = path.join(dir, `in.${sourceFormat}`);
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(outDir);
    fs.writeFileSync(inPath, buffer);

    const cmd = conversionCommand(inPath, outDir, sourceFormat, цель);

    execFile(cmd.command, cmd.args, { timeout: TIMEOUT_MS }, (err, stdout, stderr) => {
      const details = [String(stdout || '').trim(), String(stderr || '').trim()]
        .filter(Boolean).join(' | ');

      // Код возврата проверяем, но не доверяем ему: LibreOffice умеет
      // завершаться успешно, не создав файла. Решает наличие результата.
      const produced = (() => {
        try {
          return fs.readdirSync(outDir).filter((f) => f.toLowerCase().endsWith(`.${target}`));
        } catch (e) {
          return [];
        }
      })();

      if (err && err.killed) {
        cleanup(dir);
        resolve({ ok: false, status: 504, issue: `конвертер не ответил за ${TIMEOUT_MS / 1000} с`, details });
        return;
      }
      if (produced.length === 0) {
        cleanup(dir);
        resolve({
          ok: false,
          status: 502,
          issue: err
            ? `конвертер завершился с ошибкой и файл не создан`
            : `конвертер отчитался об успехе, но файла не создал`,
          details
        });
        return;
      }

      let out;
      try {
        out = fs.readFileSync(path.join(outDir, produced[0]));
      } catch (e) {
        cleanup(dir);
        resolve({ ok: false, status: 502, issue: `результат не читается: ${e.message}`, details });
        return;
      }
      cleanup(dir);

      if (out.length === 0) {
        resolve({ ok: false, status: 502, issue: 'конвертер создал пустой файл', details });
        return;
      }
      // DOCX и XLSX — это ZIP. Если подписи нет, пересохранение не удалось,
      // чем бы ни отчитался LibreOffice, и отдавать это дальше нельзя:
      // разбор молча вернёт пустой текст, а закупка уйдёт клиенту неполной.
      if (target === 'pdf') {
        if (out.slice(0, 4).toString('latin1') !== '%PDF') {
          resolve({ ok: false, status: 502, issue: 'результат не похож на PDF - пересохранение не удалось', details });
          return;
        }
      } else if (!(out[0] === 0x50 && out[1] === 0x4b)) {
        resolve({ ok: false, status: 502, issue: 'результат не похож на DOCX/XLSX — пересохранение не удалось', details });
        return;
      }

      resolve({ ok: true, buffer: out, target, name: `in.${target}` });
    });
  });
}

/**
 * Текст из PDF — программой pdftotext, с сохранением колонок (-layout).
 *
 * СКАН — НЕ ОШИБКА, А ДРУГОЙ ПУТЬ. У скана текстового слоя нет, pdftotext
 * возвращает пустоту или несколько знаков. Это честный ответ «здесь картинка»,
 * и только такой файл читает модель. Отдавать пустой текст как успех нельзя:
 * разбор не нашёл бы в нём ничего, и это выглядело бы как «в документе нет
 * таблицы», а не как «документ не прочитан».
 */
const МИНИМУМ_ТЕКСТА = 200;

function pdfText(buffer) {
  return new Promise((resolve) => {
    if (buffer.slice(0, 4).toString('latin1') !== '%PDF') {
      resolve({ ok: false, status: 400, issue: 'содержимое не является PDF' });
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-'));
    const inPath = path.join(dir, 'in.pdf');
    fs.writeFileSync(inPath, buffer);

    execFile('pdftotext', ['-layout', '-enc', 'UTF-8', inPath, '-'],
      { timeout: 60000, maxBuffer: 50 * 1024 * 1024 },
      (err, stdout, stderr) => {
        cleanup(dir);
        if (err && err.killed) {
          resolve({ ok: false, status: 504, issue: 'pdftotext не ответил за 60 с' });
          return;
        }
        if (err) {
          resolve({ ok: false, status: 502, issue: `pdftotext завершился с ошибкой: ${String(stderr || err.message).trim()}` });
          return;
        }
        const text = String(stdout || '');
        const значимых = text.replace(/\s+/g, '').length;
        if (значимых < МИНИМУМ_ТЕКСТА) {
          resolve({
            ok: false,
            status: 422,
            скан: true,
            issue: `текстового слоя нет (${значимых} знаков) — это скан, читать его может только модель`
          });
          return;
        }
        resolve({ ok: true, text, страниц: (text.match(/\f/g) || []).length + 1 });
      });
  });
}

/** execFile в виде обещания; ошибка не бросается, а возвращается. */
function запустить(cmd, args, ms) {
  return new Promise((resolve) => {
    // Кодировка UTF-8 обязательна: без неё bsdtar не переводит имена файлов
    // 7z (UTF-16) и пропускает их - «Pathname cannot be converted from
    // UTF-16LE to current locale» (32616449301, 20.10.2026). C.UTF-8 есть в
    // Debian без отдельного пакета.
    // OMP_THREAD_LIMIT=1: страницы распознаются параллельно (ocr, OCR_THREADS),
    // и каждому tesseract - одно ядро, иначе два процесса делят ядра друг у друга.
    execFile(cmd, args, { timeout: ms, maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', OMP_THREAD_LIMIT: '1' } },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

/**
 * РАСПОЗНАВАНИЕ СКАНОВ И ФОТОГРАФИЙ КОДОМ — Tesseract, 16.10.2026.
 *
 * Решение владельца: «если текст или файл — разбирай кодом, если фото —
 * делаем блок, который может это осуществить». Модель — только для поиска.
 *
 * PDF без текстового слоя режется на страницы-картинки (pdftoppm, 300 точек
 * на дюйм — меньше даёт ошибки в цифрах), каждая страница распознаётся.
 * Режим --psm 6 и preserve_interword_spaces сохраняют промежутки между
 * колонками несколькими пробелами — приложение превращает их в ячейки так же,
 * как вывод pdftotext.
 *
 * ЧЕГО ЭТО НЕ ГАРАНТИРУЕТ, ГОВОРЮ ПРЯМО. Распознавание ошибается в цифрах
 * (3 и 8, 1 и 7, потерянная запятая), а цифра в цене — место самой дорогой
 * ошибки. Поэтому ответ помечен `распознано: true`, и приложение обязано
 * сказать об этом клиенту. Таблицы с переносами внутри ячеек разваливаются.
 */
const OCR_СТРАНИЦ = Number(process.env.OCR_MAX_PAGES || 20);

function видФайла(buffer) {
  const b = buffer.slice(0, 4);
  if (b.toString('latin1') === '%PDF') return 'pdf';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) return 'tif';
  return '';
}

async function ocr(buffer) {
  const вид = видФайла(buffer);
  if (!вид) return { ok: false, status: 400, issue: 'не PDF и не картинка (PNG, JPEG, TIFF)' };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-'));
  try {
    const вход = path.join(dir, 'in.' + вид);
    fs.writeFileSync(вход, buffer);

    let картинки = [вход];
    let всегоСтраниц = 1;
    if (вид === 'pdf') {
      const инфо = await запустить('pdfinfo', [вход], 30000);
      const m = инфо.stdout.match(/Pages:\s+(\d+)/);
      всегоСтраниц = m ? Number(m[1]) : 0;
      const р = await запустить('pdftoppm',
        ['-r', '300', '-gray', '-png', '-f', '1', '-l', String(OCR_СТРАНИЦ), вход, path.join(dir, 'p')],
        300000);
      if (р.err) return { ok: false, status: 502, issue: `pdftoppm не разрезал PDF: ${(р.stderr || р.err.message).trim()}` };
      картинки = fs.readdirSync(dir).filter((f) => /^p-\d+\.png$/.test(f)).sort().map((f) => path.join(dir, f));
      if (!картинки.length) return { ok: false, status: 502, issue: 'pdftoppm отчитался об успехе, но страниц не создал' };
    }

    // ПОВЁРНУТАЯ СТРАНИЦА — 19.10.2026. Режим 6 считает страницу ровной и
    // на скане, положенном боком, выдаёт мусор («Е ЕЕЕЕЕВ бЕННОЫ»). Если
    // качество плохое, страница распознаётся повторно в режиме 1 — Tesseract
    // сам определяет поворот (словарь tesseract-ocr-osd). Берётся лучший.
    const распознать = async (к, режим) => {
      const т = await запустить('tesseract',
        [к, 'stdout', '-l', 'rus+eng', '--psm', режим, '-c', 'preserve_interword_spaces=1'], 120000);
      if (т.err && т.err.killed) return { сбой: 'tesseract не ответил за 120 с на странице', status: 504 };
      if (т.err) return { сбой: `tesseract завершился с ошибкой: ${(т.stderr || т.err.message).trim()}`, status: 502 };
      return { текст: т.stdout, качество: качествоРаспознавания(т.stdout) };
    };
    // Страницы - в OCR_THREADS потоков (по умолчанию 2 - ядер на сервере два):
    // около 12 с на страницу, скан на 19 страниц шёл почти 4 минуты
    // (пакетная проверка 23.10.2026). Порядок страниц сохраняется.
    const части = new Array(картинки.length);
    let повёрнуто = 0;
    let следующая = 0;
    let сбойСтраницы = null;
    const работник = async () => {
      while (!сбойСтраницы && следующая < картинки.length) {
        const i = следующая++;
        let р = await распознать(картинки[i], '6');
        if (р.сбой) { сбойСтраницы = р; return; }
        if (!р.качество.годится) {
          const р1 = await распознать(картинки[i], '1');
          if (!р1.сбой && р1.качество.доля > р.качество.доля) { р = р1; повёрнуто++; }
        }
        части[i] = р;
      }
    };
    const потоков = Math.max(1, Math.min(4, Number(process.env.OCR_THREADS || 2)));
    await Promise.all(Array.from({ length: Math.min(потоков, картинки.length) }, работник));
    if (сбойСтраницы) return { ok: false, status: сбойСтраницы.status, issue: сбойСтраницы.сбой };
    const text = части.map((ч) => ч.текст).join('\f');
    const значимых = text.replace(/\s+/g, '').length;
    if (значимых < МИНИМУМ_ТЕКСТА) {
      return { ok: false, status: 422, issue: `распознавание не дало текста (${значимых} знаков) — пустой скан или нечитаемое качество` };
    }
    // Мусор не отдаётся: разобранный, он мог бы дать правдоподобные числа.
    const итог = качествоРаспознавания(text);
    if (!итог.годится) {
      return { ok: false, status: 422,
        issue: `скан нечитаем: осмысленных слов ${Math.round(итог.доля * 100)}% — качество или поворот не позволяют распознать` };
    }
    return {
      ok: true, text, распознано: true,
      страниц: картинки.length, всегоСтраниц,
      обрезано: всегоСтраниц > картинки.length,
      повёрнутоСтраниц: повёрнуто
    };
  } finally {
    cleanup(dir);
  }
}

/**
 * РАСПАКОВКА RAR И 7z — bsdtar (libarchive), 20.10.2026.
 *
 * Архивы — частая причина неудач: в бумаге 5 из 13, в «слаботочке» уже 2.
 * ZIP приложение распаковывает само; RAR и 7z своим кодом не прочитать.
 * bsdtar — из основного репозитория Debian, читает 7z, RAR (и RAR5), ZIP, tar.
 *
 * Защита от архива-бомбы: сначала ОГЛАВЛЕНИЕ (bsdtar -tv), и только если
 * файлов не больше РАСП_ФАЙЛОВ, каждый не больше РАСП_ФАЙЛ, а все вместе не
 * больше РАСП_ВСЕГО, — распаковка. Вложенные архивы не раскрываются.
 * Зашифрованный архив — отказ с причиной.
 */
// 60, а не 20: в 7z закупки 32616449301 40 файлов, и архив отвергался целиком
// (20.10.2026). От бомбы защищают пределы размера; из распакованного
// приложение берёт 10 самых нужных по назначению.
const РАСП_ФАЙЛОВ = 60;
const РАСП_ФАЙЛ = 30 * 1024 * 1024;
const РАСП_ВСЕГО = 150 * 1024 * 1024;

async function распаковать(buffer, тома = null) {
  // МНОГОТОМНЫЙ RAR (25.10.2026): тома приходят одним телом, размеры - в
  // заголовке X-Volume-Sizes; пишутся in.part1.rar, in.part2.rar…, читает
  // их unar (bsdtar многотомные RAR не читает).
  if (тома && тома.length > 1) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unp-'));
    try {
      let p = 0;
      тома.forEach((размер, i) => { fs.writeFileSync(path.join(dir, `in.part${i + 1}.rar`), buffer.slice(p, p + размер)); p += размер; });
      if (p !== buffer.length) return { ok: false, status: 400, issue: 'размеры томов не сходятся с телом запроса' };
      return await распаковатьUnar(path.join(dir, 'in.part1.rar'), dir, 'rar');
    } finally {
      cleanup(dir);
    }
  }
  const b = buffer.slice(0, 6);
  const вид = b.slice(0, 4).toString('latin1') === 'Rar!' ? 'rar'
    : (b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf) ? '7z'
      : (b[0] === 0x50 && b[1] === 0x4b) ? 'zip' : '';
  if (!вид) return { ok: false, status: 400, issue: 'не архив RAR, 7z или ZIP' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unp-'));
  try {
    const вход = path.join(dir, 'in.' + вид);
    fs.writeFileSync(вход, buffer);
    const куда = path.join(dir, 'out');
    fs.mkdirSync(куда);
    const список = await запустить('bsdtar', ['-tvf', вход], 60000);
    let р = null;
    if (!список.err) {
      // Строка оглавления: права, ссылки, владелец, группа, размер, дата, имя.
      const записи = список.stdout.split('\n').filter(Boolean).map((s) => {
        const m = s.match(/^(\S+)\s+\S+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/);
        return m ? { папка: m[1].startsWith('d'), размер: Number(m[2]), имя: m[3] } : null;
      }).filter(Boolean);
      const отказ = проверитьРазмерАрхива(записи.filter((з) => !з.папка));
      if (отказ) return отказ;
      р = await запустить('bsdtar', ['-xf', вход, '-C', куда], 120000);
    }
    if (список.err || (р && р.err)) {
      const т = текстОшибки(список.err ? список : р);
      if (парольный(т)) return { ok: false, status: 422, issue: 'архив зашифрован паролем' };
      // RAR «solid» bsdtar не читает («RAR solid archive support unavailable»,
      // 0318300552926000852) - его читает unar (основной репозиторий Debian,
      // 25.10.2026), проверено на этой закупке.
      if (вид !== 'rar') return { ok: false, status: 422, issue: `архив не читается: ${т.slice(0, 200)}` };
      return await распаковатьUnar(вход, dir, вид, т);
    }
    return { ok: true, вид, ...обойтиРаспакованное(куда) };
  } finally {
    cleanup(dir);
  }
}

const парольный = (т) => /encrypt|passphrase|password/i.test(т);
const текстОшибки = (x) => (x.stderr || (x.err && x.err.message) || '').trim();

function проверитьРазмерАрхива(файлы) {
  const всего = файлы.reduce((s, з) => s + з.размер, 0);
  if (файлы.length > РАСП_ФАЙЛОВ) return { ok: false, status: 413, issue: `в архиве ${файлы.length} файлов — больше ${РАСП_ФАЙЛОВ}` };
  if (всего > РАСП_ВСЕГО) return { ok: false, status: 413, issue: `содержимое ${Math.round(всего / 1048576)} МБ — больше ${РАСП_ВСЕГО / 1048576} МБ` };
  return null;
}

/** unar: оглавление с размерами (lsar -j) - те же пределы, затем распаковка. */
async function распаковатьUnar(вход, dir, вид, прежняяОшибка = '') {
  const куда = path.join(dir, 'out-unar');
  fs.mkdirSync(куда, { recursive: true });
  const лс = await запустить('lsar', ['-j', вход], 60000);
  let записи = null;
  try { записи = JSON.parse(лс.stdout).lsarContents || null; } catch (e) { /* ниже */ }
  if (!записи) return { ok: false, status: 422, issue: `архив не читается ни bsdtar, ни unar: ${прежняяОшибка.slice(0, 120)} | ${текстОшибки(лс).slice(0, 120)}` };
  if (записи.some((з) => з.XADIsEncrypted)) return { ok: false, status: 422, issue: 'архив зашифрован паролем' };
  const отказ = проверитьРазмерАрхива(записи.filter((з) => !з.XADIsDirectory).map((з) => ({ размер: Number(з.XADFileSize) || 0 })));
  if (отказ) return отказ;
  const у = await запустить('unar', ['-q', '-f', '-D', '-o', куда, вход], 120000);
  if (у.err) return { ok: false, status: 422, issue: `распаковка не удалась (unar): ${текстОшибки(у).slice(0, 200)}` };
  return { ok: true, вид, ...обойтиРаспакованное(куда) };
}

/** Файлы распакованного: ссылки, слишком большие и вложенные архивы - пропуском с причиной. */
function обойтиРаспакованное(куда) {
  const файлы = [];
  const пропущено = [];
  const обойти = (папка, префикс) => {
    for (const имя of fs.readdirSync(папка)) {
      const полное = path.join(папка, имя);
      const ст = fs.lstatSync(полное);
      if (ст.isSymbolicLink()) { пропущено.push({ имя: префикс + имя, причина: 'ссылка, не файл' }); continue; }
      if (ст.isDirectory()) { обойти(полное, префикс + имя + '/'); continue; }
      if (ст.size > РАСП_ФАЙЛ) { пропущено.push({ имя: префикс + имя, причина: `больше ${РАСП_ФАЙЛ / 1048576} МБ` }); continue; }
      // Вложенный архив отдаётся наружу только по ?nested=1 (обработчик
      // /unpack): раскрывает его приложение, один уровень (27.10.2026).
      if (/\.(zip|rar|7z)$/i.test(имя)) { вложенные.push({ имя: префикс + имя, base64: fs.readFileSync(полное).toString('base64') }); continue; }
      файлы.push({ имя: префикс + имя, base64: fs.readFileSync(полное).toString('base64') });
    }
  };
  const вложенные = [];
  обойти(куда, '');
  return { файлы, пропущено, вложенные };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://converter');

  const send = (status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  };

  if (req.method === 'GET' && url.pathname === '/health') {
    execFile('soffice', ['--version'], { timeout: 30000 }, (err, stdout) => {
      if (err) {
        send(500, { ok: false, issue: `LibreOffice не отвечает: ${err.message}` });
        return;
      }
      // pdftotext проверяется тоже: без него PDF молча уходили бы в модель
      // как «сканы», то есть за деньги, и выглядело бы это как обычная работа.
      execFile('pdftotext', ['-v'], { timeout: 10000 }, (err2, out2, err2text) => {
        if (err2) {
          send(500, { ok: false, issue: `pdftotext не установлен или не отвечает: ${err2.message}` });
          return;
        }
        // Tesseract и русский язык проверяются тоже: без русского словаря
        // распознавание выдаёт латинский мусор, и это выглядело бы как
        // «плохой скан», а не как поломка сборки.
        execFile('tesseract', ['--list-langs'], { timeout: 10000 }, (err3, out3, err3text) => {
          const языки = String(out3 || '') + String(err3text || '');
          if (err3 || !/^rus$/m.test(языки)) {
            send(500, { ok: false, issue: `tesseract не установлен или нет русского языка: ${err3 ? err3.message : языки.trim()}` });
            return;
          }
          send(200, {
            ok: true,
            soffice: String(stdout).trim(),
            pdftotext: String(err2text || out2).split('\n')[0].trim(),
            tesseract: 'rus есть',
            formats: CONVERT_TO
          });
        });
      });
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/ocr') {
    let buffer;
    try {
      buffer = await readBody(req);
    } catch (e) {
      send(413, { ok: false, issue: e.message });
      return;
    }
    if (!buffer || buffer.length === 0) {
      send(400, { ok: false, issue: 'тело запроса пустое — файл не прислан' });
      return;
    }
    const started = Date.now();
    const r = await ocr(buffer);
    const ms = Date.now() - started;
    if (!r.ok) {
      log(`OCR СБОЙ ${buffer.length} байт за ${ms} мс: ${r.issue}`);
      send(r.status, { ok: false, issue: r.issue });
      return;
    }
    log(`OCR ОК ${buffer.length} байт, страниц ${r.страниц} из ${r.всегоСтраниц}, ${r.text.length} знаков, ${ms} мс`);
    send(200, r);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/unpack') {
    let buffer;
    try {
      buffer = await readBody(req);
    } catch (e) {
      send(413, { ok: false, issue: e.message });
      return;
    }
    if (!buffer || buffer.length === 0) {
      send(400, { ok: false, issue: 'тело запроса пустое — файл не прислан' });
      return;
    }
    const started = Date.now();
    const тома = (url.searchParams.get('volumes') || '').split(',').map(Number).filter((n) => n > 0);
    const r = await распаковать(buffer, тома.length > 1 ? тома : null);
    if (r.ok) {
      const вл = r.вложенные || [];
      delete r.вложенные;
      if (url.searchParams.get('nested') === '1') r.файлы.push(...вл);
      else r.пропущено.push(...вл.map((в) => ({ имя: в.имя, причина: 'вложенный архив не раскрывается' })));
    }
    log(`РАСПАКОВКА ${r.ok ? 'ОК' : 'СБОЙ'} ${buffer.length} байт за ${Date.now() - started} мс: `
      + (r.ok ? `${r.вид}, файлов ${r.файлы.length}, пропущено ${r.пропущено.length}` : r.issue));
    send(r.ok ? 200 : r.status, r);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/pdf-text') {
    let buffer;
    try {
      buffer = await readBody(req);
    } catch (e) {
      send(413, { ok: false, issue: e.message });
      return;
    }
    if (!buffer || buffer.length === 0) {
      send(400, { ok: false, issue: 'тело запроса пустое — файл не прислан' });
      return;
    }
    const started = Date.now();
    const r = await pdfText(buffer);
    const ms = Date.now() - started;
    if (!r.ok) {
      log(`PDF ${r.скан ? 'СКАН' : 'СБОЙ'} ${buffer.length} байт за ${ms} мс: ${r.issue}`);
      send(r.status, { ok: false, issue: r.issue, скан: !!r.скан });
      return;
    }
    log(`PDF ОК ${buffer.length} байт, ${r.text.length} знаков, страниц ${r.страниц}, ${ms} мс`);
    send(200, { ok: true, text: r.text, страниц: r.страниц });
    return;
  }

  if (req.method !== 'POST' || url.pathname !== '/convert') {
    send(404, { ok: false, issue: 'есть только POST /convert, POST /pdf-text, POST /ocr, POST /unpack и GET /health' });
    return;
  }

  // Имя файла нужно только затем, чтобы узнать исходный формат.
  const name = url.searchParams.get('name') || '';
  const format = url.searchParams.get('format') || extOf(name);
  const цель = url.searchParams.get('to') === 'pdf' ? 'pdf' : null;
  if (!conversionCommand('x', 'y', format, цель)) {
    send(400, {
      ok: false,
      issue: `не понял исходный формат (name=«${name}», format=«${format}»). Поддерживаются: ${Object.keys(CONVERT_TO).join(', ')}`
    });
    return;
  }

  let buffer;
  try {
    buffer = await readBody(req);
  } catch (e) {
    send(413, { ok: false, issue: e.message });
    return;
  }
  if (!buffer || buffer.length === 0) {
    send(400, { ok: false, issue: 'тело запроса пустое — файл не прислан' });
    return;
  }

  const started = Date.now();
  const result = await convert(buffer, format, цель);
  const ms = Date.now() - started;

  if (!result.ok) {
    log(`СБОЙ ${format} ${buffer.length} байт за ${ms} мс: ${result.issue}`, result.details || '');
    send(result.status, { ok: false, issue: result.issue, details: result.details || '' });
    return;
  }

  log(`ОК ${format} -> ${result.target}, ${buffer.length} -> ${result.buffer.length} байт за ${ms} мс`);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': result.buffer.length,
    'X-Converted-To': result.target
  });
  res.end(result.buffer);
});

server.listen(PORT, () => log(`конвертер слушает порт ${PORT}`));
