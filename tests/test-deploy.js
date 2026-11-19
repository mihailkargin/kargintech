/** Статические проверки комплекта развёртывания, без сервера и сети. */
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (ok, message) => {
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${message}`);
  if (!ok) failures++;
};
const read = (имя) => fs.readFileSync(path.join(__dirname, '..', имя), 'utf8');

const kit = read('deploy/send-kit.ps1');
check(/\$parts = 'src app site deploy n8n package\.json'/.test(kit), 'основной комплект содержит код и воркфлоу n8n');
check(kit.includes('--exclude=deploy/.env ') && kit.includes('--exclude=deploy/.env.bak*'), 'секреты и резервные .env не входят в комплект');
check(kit.charCodeAt(0) === 0xFEFF && read('deploy/yandex-key.ps1').charCodeAt(0) === 0xFEFF, 'PowerShell 5.1: файлы с кириллицей сохранены в UTF-8 с BOM');

const portal = read('deploy/check-portal.sh');
check(portal.includes('docker compose exec -T app') && !portal.includes('docker compose exec -T n8n'), 'ЕИС проверяется из app, не из n8n с зарубежным прокси');
check(portal.includes('/opt/tender/src/parser.js'), 'проверка использует текущий путь парсера');
check(portal.includes('HTTP_PROXY') && portal.includes('HTTPS_PROXY'), 'проверка явно отсекает глобальный прокси у app');
check(!/NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized\s*[:=]\s*false/.test(portal), 'TLS не отключается');

const converter = read('deploy/check-converter.sh');
check(converter.includes('for service in n8n app'), 'конвертер проверяется из обоих вызывающих контейнеров');

const setup = read('deploy/setup-server.sh');
check(setup.includes("curl -fsS") && setup.includes('KarginTech/1.0'), 'проверка ЕИС при установке не принимает HTTP-ошибку и использует честный User-Agent');

const kargin = JSON.parse(read('deploy/clients/kargin.json'));
check(!Object.hasOwn(kargin, 'искатьПоПозициям'), 'боевой тестовый профиль ищет цены по всем позициям по умолчанию');
const example = JSON.parse(read('deploy/clients/client-example.json'));
check(example.economics.expectedDiscount === 0.25, 'образец использует измеренное снижение 25%');
check(!Object.hasOwn(example, 'искатьПоПозициям'), 'образец не включает отладочный предел позиций');

const move = read('deploy/MOVE-NEW-SERVER.md');
check(move.includes('n8n import:workflow') && move.includes('bash check-portal.sh'), 'переезд включает импорт воркфлоу и настоящую проверку ЕИС');
check(move.includes('if [ ! -e /data/clients/kargin.json ]'), 'первичный профиль не перезаписывает существующие настройки');
const zip = read('deploy/send-kit-zip.py');
check(zip.includes("'n8n', 'package.json'") && zip.includes("name.startswith('.env.bak')"), 'запасной ZIP-передатчик содержит воркфлоу и исключает .env');
check(zip.includes("System32/OpenSSH/ssh.exe") && zip.includes('[ssh,'), 'ZIP-передатчик использует системный OpenSSH на Windows');

console.log(failures ? `\nПРОВЕРОК НЕ ПРОШЛО: ${failures}` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
process.exit(failures ? 1 : 0);
