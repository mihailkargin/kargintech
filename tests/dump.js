/** Печатает разобранные карточки для визуальной сверки. */
const fs = require('fs');
const path = require('path');
const { parseSearchPage } = require('../src/parser');

const file = process.argv[2] || 'search-bumaga-2026-09-19.html';
const html = fs.readFileSync(path.join(__dirname, '..', 'fixtures', file), 'utf8');

parseSearchPage(html).forEach((t, i) => {
  console.log(`${i + 1}. ${t.number}  [${t.law}]  ${t.status}`);
  console.log(`   НМЦК     : "${t.priceRaw}"  ->  ${t.price}`);
  console.log(`   Даты     : размещено ${t.published}, дедлайн ${t.deadline}`);
  console.log(`   ${t.orgRole}: ${t.orgName.slice(0, 75)}`);
  console.log(`   Объект   : ${t.object.slice(0, 75)}`);
  console.log('');
});
