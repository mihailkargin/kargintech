// Печатает ответ /health конвертера: LibreOffice, pdftotext и Tesseract с русским.
// Запуск на сервере из ~/kargintech/deploy:
//   docker compose exec -T converter node - < converter/health-check.js
require('http').get('http://127.0.0.1:3000/health', (r) => {
  let тело = '';
  r.on('data', (c) => { тело += c; });
  r.on('end', () => {
    console.log(`код ${r.statusCode}: ${тело}`);
    process.exit(r.statusCode === 200 ? 0 : 1);
  });
}).on('error', (e) => { console.log('конвертер не отвечает: ' + e.message); process.exit(1); });
