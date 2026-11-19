/**
 * Тест: в deploy/.env.example есть каждая настройка, которую читают
 * docker-compose.yml и скрипты копий. 02.11.2026 сервер пропал вместе с .env,
 * а образец отставал на 24 настройки - восстанавливать пришлось бы по коду.
 * Запуск: node tests/test-env-example.js
 */
const fs = require('fs');
const path = require('path');

const deploy = path.join(__dirname, '..', 'deploy');
// ENV_EXAMPLE - другой образец (проверить, что старый тест не пропускает).
const пример = fs.readFileSync(process.env.ENV_EXAMPLE || path.join(deploy, '.env.example'), 'utf8');
const есть = new Set([...пример.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));

const нужны = new Set();
const compose = fs.readFileSync(path.join(deploy, 'docker-compose.yml'), 'utf8');
for (const m of compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)) нужны.add(m[1]);
for (const f of ['backup.sh', 'backup-offsite.sh']) {
  const s = fs.readFileSync(path.join(deploy, f), 'utf8');
  for (const m of s.matchAll(/env_value ([A-Z][A-Z0-9_]*)/g)) нужны.add(m[1]);
}

let failures = 0;
function check(ok, label) {
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${label}`);
  if (!ok) failures++;
}

console.log('=== Настройки из кода есть в .env.example ===');
check(нужны.size >= 30, `найдено настроек в коде: ${нужны.size} (проверка видит compose и скрипты)`);
const нет = [...нужны].filter((v) => !есть.has(v));
check(!нет.length, нет.length ? `нет в образце: ${нет.join(', ')}` : 'все на месте');
check(есть.has('OFFSITE_HOST') && есть.has('OFFSITE_CERT'), 'копия вне сервера в образце');
check(!/^[A-Z_]*(KEY|PASSWORD|SECRET)=\S/m.test(пример), 'в образце нет заполненных ключей и паролей');

console.log(failures ? `\nСБОЕВ: ${failures}` : '\nВсе проверки прошли');
process.exit(failures ? 1 : 0);
