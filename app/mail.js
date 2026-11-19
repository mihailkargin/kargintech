/**
 * ПОЧТА — отправка (SMTP) и чтение ответов (IMAP), без сторонних библиотек.
 * 21.10.2026, для запросов КП поставщикам (src/kp.js).
 *
 * Ящик на домене kargintech.ru заводит владелец, пароль для программ вводит
 * сам в .env: MAIL_USER, MAIL_PASSWORD, MAIL_SMTP_HOST, MAIL_IMAP_HOST
 * (порты MAIL_SMTP_PORT=465, MAIL_IMAP_PORT=993 - шифрование сразу, TLS).
 * Без них почта выключена, и это сказано словами.
 *
 * Проверка сертификата сервера НЕ ОТКЛЮЧАЕТСЯ (правило безопасности №6).
 * Опция tls:false существует только для проверок с подставным сервером.
 */
const tls = require('tls');
const net = require('net');
const crypto = require('crypto');

function настройкиПочты(env = process.env) {
  const н = {
    user: String(env.MAIL_USER || '').trim(),
    password: String(env.MAIL_PASSWORD || ''),
    smtpHost: String(env.MAIL_SMTP_HOST || '').trim(),
    smtpPort: Number(env.MAIL_SMTP_PORT || 465),
    imapHost: String(env.MAIL_IMAP_HOST || '').trim(),
    imapPort: Number(env.MAIL_IMAP_PORT || 993),
    имя: String(env.MAIL_FROM_NAME || 'KarginTech').trim()
  };
  return н.user && н.password && н.smtpHost && н.imapHost ? н : null;
}

function соединиться(host, port, вTls = true, мс = 30000) {
  return new Promise((ok, нет) => {
    const s = вTls ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    s.setTimeout(мс, () => s.destroy(new Error(`почтовый сервер ${host} не ответил`)));
    s.once(вTls ? 'secureConnect' : 'connect', () => ok(s));
    s.once('error', нет);
  });
}

/** Читатель строк ответа сервера поверх сокета. */
function читатель(s) {
  let буфер = Buffer.alloc(0);
  const ждут = [];
  let ошибка = null;
  const разобрать = () => {
    while (ждут.length) {
      const р = ждут[0];
      const n = р.байт !== undefined ? (буфер.length >= р.байт ? р.байт : -1) : буфер.indexOf('\r\n');
      if (n < 0) return;
      ждут.shift();
      const кусок = буфер.slice(0, р.байт !== undefined ? n : n);
      буфер = буфер.slice(р.байт !== undefined ? n : n + 2);
      р.ok(кусок);
    }
  };
  s.on('data', (c) => { буфер = Buffer.concat([буфер, c]); разобрать(); });
  const стоп = (e) => { ошибка = e || new Error('соединение закрыто'); while (ждут.length) ждут.shift().нет(ошибка); };
  s.on('error', стоп);
  s.on('close', () => стоп());
  return {
    строка: () => new Promise((ok, нет) => { if (ошибка) return нет(ошибка); ждут.push({ ok: (b) => ok(b.toString('utf8')), нет }); разобрать(); }),
    байты: (n) => new Promise((ok, нет) => { if (ошибка) return нет(ошибка); ждут.push({ байт: n, ok, нет }); разобрать(); })
  };
}

// --- SMTP --------------------------------------------------------------------

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const заголовокUtf8 = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const строки76 = (s) => s.replace(/(.{76})/g, '$1\r\n');

/** Письмо целиком (RFC 5322), текст в base64 - точку в начале строки экранировать не нужно. */
function собратьПисьмо({ от, имяОт, кому, тема, текст, ответНа, идСообщения }) {
  const ид = идСообщения || `<${crypto.randomBytes(12).toString('hex')}@${от.split('@')[1]}>`;
  return {
    ид,
    данные: [
      `From: ${заголовокUtf8(имяОт || '')} <${от}>`,
      `To: <${кому}>`,
      `Subject: ${заголовокUtf8(тема)}`,
      `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
      `Message-ID: ${ид}`,
      ...(ответНа ? [`Reply-To: <${ответНа}>`] : []),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      строки76(b64(текст)),
      ''
    ].join('\r\n')
  };
}

async function отправить(н, письмо, опции = {}) {
  if (!н) return { ok: false, сбой: 'почта не настроена' };
  const кому = String(письмо.кому || '').trim();
  if (!/^[^\s<>@]+@[^\s<>@]+\.[a-z]{2,24}$/i.test(кому)) return { ok: false, сбой: 'адрес получателя не похож на почту' };
  let s;
  try {
    s = await соединиться(н.smtpHost, н.smtpPort, опции.tls !== false);
    const р = читатель(s);
    const ответ = async () => {
      let с = await р.строка();
      let всё = с;
      while (/^\d{3}-/.test(с)) { с = await р.строка(); всё += '\n' + с; }
      return { код: Number(с.slice(0, 3)), текст: всё };
    };
    const команда = async (cmd, ждём) => {
      if (cmd !== null) s.write(cmd + '\r\n');
      const о = await ответ();
      if (!ждём.includes(о.код)) throw new Error(`SMTP: ${cmd === null ? 'приветствие' : cmd.split(' ')[0]} → ${о.текст.slice(0, 200)}`);
      return о;
    };
    await команда(null, [220]);
    await команда(`EHLO ${н.user.split('@')[1] || 'localhost'}`, [250]);
    await команда('AUTH LOGIN', [334]);
    await команда(b64(н.user), [334]);
    await команда(b64(н.password), [235]);
    await команда(`MAIL FROM:<${н.user}>`, [250]);
    await команда(`RCPT TO:<${кому}>`, [250, 251]);
    await команда('DATA', [354]);
    const п = собратьПисьмо({ от: н.user, имяОт: н.имя, кому, тема: письмо.тема, текст: письмо.текст });
    s.write(п.данные + '\r\n.\r\n');
    await команда(null, [250]);
    s.write('QUIT\r\n');
    return { ok: true, ид: п.ид };
  } catch (e) {
    // Пароль в сообщение об ошибке не попадает: команда AUTH печатается одним словом.
    return { ok: false, сбой: e.message };
  } finally {
    if (s) s.end();
  }
}

// --- разбор письма (MIME) ------------------------------------------------------

function раскодироватьБайты(буфер, кодировка) {
  const к = String(кодировка || 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  try { return new TextDecoder(к === 'utf8' ? 'utf-8' : к).decode(буфер); } catch (e) { return буфер.toString('utf8'); }
}
const изQp = (s) => {
  const байты = [];
  const t = String(s).replace(/=\r?\n/g, '');
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '=' && /^[0-9a-f]{2}$/i.test(t.slice(i + 1, i + 3))) { байты.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; } else байты.push(...Buffer.from(t[i], 'latin1'));
  }
  return Buffer.from(байты);
};
/** Заголовок с =?charset?B|Q?...?= (RFC 2047). */
function заголовок(s) {
  return String(s || '').replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, cs, вид, т) => {
    const буфер = вид.toLowerCase() === 'b' ? Buffer.from(т, 'base64') : изQp(т.replace(/_/g, ' '));
    return раскодироватьБайты(буфер, cs);
  });
}
function заголовки(текст) {
  const out = {};
  for (const с of текст.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = с.indexOf(':');
    if (i > 0) out[с.slice(0, i).trim().toLowerCase()] = с.slice(i + 1).trim();
  }
  return out;
}
const параметр = (значение, имя) => {
  const m = String(значение || '').match(new RegExp(`${имя}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, 'i'));
  return m ? (m[2] !== undefined ? m[2] : m[1]) : '';
};
const безТегов = (html) => String(html).replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
  .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ');

/** Текст письма: первая часть text/plain, иначе text/html без разметки. Вложения не читаются. */
function разобратьПисьмо(сырое) {
  const буфер = Buffer.isBuffer(сырое) ? сырое : Buffer.from(String(сырое), 'latin1');
  const часть = (б, глубина = 0) => {
    const s = б.toString('latin1');
    const i = s.search(/\r?\n\r?\n/);
    const з = заголовки(i >= 0 ? s.slice(0, i) : s);
    const тело = i >= 0 ? б.slice(Buffer.byteLength(s.slice(0, i), 'latin1') + (s.slice(i).startsWith('\r\n\r\n') ? 4 : 2)) : Buffer.alloc(0);
    const тип = String(з['content-type'] || 'text/plain').toLowerCase();
    if (тип.startsWith('multipart/') && глубина < 5) {
      const граница = параметр(з['content-type'], 'boundary');
      if (!граница) return { з, текст: '', html: '' };
      const части = тело.toString('latin1').split('--' + граница).slice(1).filter((x) => !x.startsWith('--'));
      let текст = '';
      let html = '';
      for (const ч of части) {
        const р = часть(Buffer.from(ч.replace(/^\r?\n/, ''), 'latin1'), глубина + 1);
        if (!текст && р.текст) текст = р.текст;
        if (!html && р.html) html = р.html;
      }
      return { з, текст, html };
    }
    if (/attachment/i.test(з['content-disposition'] || '')) return { з, текст: '', html: '' };
    const кодирование = String(з['content-transfer-encoding'] || '').toLowerCase();
    const сырое2 = кодирование === 'base64' ? Buffer.from(тело.toString('latin1').replace(/\s+/g, ''), 'base64')
      : (кодирование === 'quoted-printable' ? изQp(тело.toString('latin1')) : тело);
    const т = раскодироватьБайты(сырое2, параметр(з['content-type'], 'charset') || 'utf-8');
    if (тип.startsWith('text/html')) return { з, текст: '', html: т };
    if (тип.startsWith('text/')) return { з, текст: т, html: '' };
    return { з, текст: '', html: '' };
  };
  const р = часть(буфер);
  const от = заголовок(р.з.from || '');
  return {
    тема: заголовок(р.з.subject || ''),
    от,
    почтаОт: ((от.match(/<([^>]+)>/) || [])[1] || (от.match(/[^\s<>]+@[^\s<>]+/) || [''])[0]).toLowerCase(),
    дата: р.з.date || '',
    текст: (р.текст || безТегов(р.html)).replace(/\r/g, '').trim()
  };
}

// --- IMAP ----------------------------------------------------------------------

const кавычки = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Непрочитанные письма из «Входящих»: читает и помечает прочитанными.
 * Не больше предел писем за раз.
 */
async function новыеПисьма(н, опции = {}) {
  if (!н) return { ok: false, сбой: 'почта не настроена', письма: [] };
  const предел = опции.предел || 30;
  let s;
  let номер = 0;
  try {
    s = await соединиться(н.imapHost, н.imapPort, опции.tls !== false);
    const р = читатель(s);
    await р.строка(); // приветствие
    /** Команда с меткой; литералы {n} читаются байтами. */
    const команда = async (cmd) => {
      const т = `A${++номер}`;
      s.write(`${т} ${cmd}\r\n`);
      const ответы = [];
      for (;;) {
        let с = await р.строка();
        const m = с.match(/\{(\d+)\}$/);
        if (m) {
          const данные = await р.байты(Number(m[1]));
          const хвост = await р.строка();
          ответы.push({ строка: с, данные, хвост });
          continue;
        }
        if (с.startsWith(т + ' ')) {
          if (!/^\S+ OK/i.test(с)) throw new Error(`IMAP: ${cmd.split(' ')[0]} → ${с.slice(т.length + 1, 200)}`);
          return ответы;
        }
        ответы.push({ строка: с });
      }
    };
    await команда(`LOGIN ${кавычки(н.user)} ${кавычки(н.password)}`);
    await команда('SELECT INBOX');
    const поиск = await команда('UID SEARCH UNSEEN');
    const uid = ((поиск.find((x) => /^\* SEARCH/i.test(x.строка)) || {}).строка || '').replace(/^\* SEARCH/i, '').trim().split(/\s+/).filter(Boolean).slice(0, предел);
    const письма = [];
    for (const u of uid) {
      const ф = await команда(`UID FETCH ${u} (BODY.PEEK[])`);
      const с = ф.find((x) => x.данные);
      if (с) письма.push({ uid: u, ...разобратьПисьмо(с.данные) });
      await команда(`UID STORE ${u} +FLAGS (\\Seen)`);
    }
    await команда('LOGOUT').catch(() => []);
    return { ok: true, письма };
  } catch (e) {
    return { ok: false, сбой: e.message.replace(/LOGIN\s.*/, 'LOGIN'), письма: [] };
  } finally {
    if (s) s.end();
  }
}

module.exports = { настройкиПочты, отправить, новыеПисьма, разобратьПисьмо, собратьПисьмо, заголовок };
