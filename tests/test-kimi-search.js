/** Kimi для сравнения поставщиков: только преобразование запроса, без сети. */
const { настройкиЯндекса, телоДляПровайдера } = require('../app/yandex-run');
let failures = 0;
const check = (ok, message) => { console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${message}`); if (!ok) failures++; };

const я = настройкиЯндекса({ провайдер: 'kimi', kimiKey: 'test', kimiModel: 'kimi-k2.8-preview', yandexFolder: 'folder' });
check(я.провайдер === 'kimi' && я.ключ === 'test' && я.папка === 'folder', 'ключ Kimi и папка поиска разделены');
check(я.модель === 'kimi-k2.8-preview', 'используется K2.8 Preview вместо флагманской K3.1 Pro');
const исходное = { model: 'gpt://folder/old/latest', max_tokens: 3000, temperature: 0, messages: [] };
const тело = телоДляПровайдера(исходное, я);
check(тело.model === 'kimi-k2.8-preview' && тело.reasoning_effort === 'low', 'модель и уровень рассуждения заданы явно');
check(тело.max_completion_tokens === 3000 && !Object.hasOwn(тело, 'max_tokens'), 'используется актуальный предел вывода Kimi');
check(тело.response_format.type === 'json_object', 'ответ ограничен JSON');
check(телоДляПровайдера(исходное, { провайдер: 'yandex' }) === исходное, 'запрос Yandex не меняется');

console.log(failures ? `ПРОВЕРОК НЕ ПРОШЛО: ${failures}` : 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
process.exit(failures ? 1 : 0);
