import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPlaceIndex, parsePost } from '../lib/alerts.js';

const places = loadPlaceIndex();

test('Telegram watcher loads with the current alert timing rules', async () => {
  const { startTelegramWatcher } = await import('../lib/telegram-watcher.js');
  assert.equal(typeof startTelegramWatcher, 'function');
});

test('explicit danger identifies the intended settlement, not a similarly named village', () => {
  const result = parsePost('МО Раменское\nМосковская область\nОпасность по БПЛА\nМеры безопасности', places);
  assert.equal(result.kind, 'danger');
  assert.equal(result.place.id, 502965);
  assert.equal(parsePost('ГО Бронницы\nМосковская область\nРакетная опасность', places).place.name, 'Бронницы');
});

test('unrelated news and predictions do not create warnings', () => {
  for (const text of [
    'МО Раменское\nПрогноз ракетной опасности на ночь',
    'МО Раменское\nОпасности по БПЛА нет',
    'Раменское\nВозможная опасность по БПЛА',
    'За ночь сбито 149 БПЛА над Кубанью'
  ]) assert.equal(parsePost(text, places).kind, 'ignore', text);
});

test('regions and districts are recognized without confusing them with settlements', () => {
  const region = parsePost('Московская область\nОпасность по БПЛА', places);
  assert.equal(region.kind, 'danger');
  assert.equal(region.place.areaType, 'region');
  assert.equal(region.place.region, '47');
  const district = parsePost('Знаменский район\nОрловская область\nОпасность по БПЛА', places);
  assert.equal(district.kind, 'danger');
  assert.equal(district.place.areaType, 'district');
  assert.equal(district.place.region, '56');
  assert.equal(parsePost('Знаменский район\nОпасность по БПЛА', places).kind, 'ignore');
  assert.deepEqual(parsePost('МО Раменское\nМосковская область\nОпасность по БПЛА', places).places.map(place => place.areaType), ['settlement']);
  assert.deepEqual(parsePost('Знаменский район\nОрловская область\nОпасность по БПЛА', places).places.map(place => place.areaType), ['district']);
});

test('clear message may target a town or all current warnings', () => {
  assert.equal(parsePost('МО Раменское\nОтбой опасности по БПЛА', places).place.id, 502965);
  assert.equal(parsePost('Московская область\nОтбой опасности по БПЛА', places).regions[0], '47');
  assert.deepEqual(parsePost('Отбой', places).places, []);
  assert.equal(parsePost('МО Раменское\nОтбой', places).place.id, 502965);
  assert.equal(parsePost('МО Раменское\nОпасность по БПЛА\nОтбой опасности по БПЛА', places).kind, 'clear');
});

test('second channel formats identify cities and scoped clearances', () => {
  const danger = parsePost('Геленджик и близлежащие\nАнапа и близлежащие\nНовороссийск и близлежащие\nКраснодарский край\nОпасность по БПЛА\n❗️Радар по всей России - @radarrussiia', places);
  assert.equal(danger.kind, 'danger');
  assert.deepEqual(danger.places.map(place => place.name), ['Геленджик', 'Анапа', 'Новороссийск']);
  assert.deepEqual(danger.regions, ['38']);
  assert.deepEqual(parsePost('Краснодарский край\nРеспублика Адыгея\nОтбой опасности по БПЛА', places).regions, ['38', '01']);
  assert.equal(parsePost('Пыскор и близлежащие, Пермский край - опасность по БПЛА и в направлении Березники.', places).place?.name, 'Пыскор');
  assert.equal(parsePost('Пыскор и близлежащие, Пермский край - опасность по БПЛА и в направлении Березники.', places).direction?.to.name, 'Березники');
  assert.equal(parsePost('Геленджик\nКраснодарский край\nТревога по БПЛА', places).kind, 'danger');
  assert.equal(parsePost('Краснодарский край\nОпасность по БПЛА', places).place.areaType, 'region');
  assert.equal(parsePost('За ночь сбито 149 БПЛА над Кубанью', places).kind, 'ignore');
  assert.equal(parsePost('Знаменский район\nОрловская область\nФиксация БПЛА', places).kind, 'danger');
});

test('direction needs one known origin and one known destination', () => {
  const directed = parsePost('МО Раменское\nМосковская область\nФиксация БПЛА в направлении Подольска', places);
  assert.equal(directed.place.name, 'Раменское');
  assert.equal(directed.direction?.from.name, 'Раменское');
  assert.equal(directed.direction?.to.name, 'Подольск');
  assert.equal(parsePost('МО Раменское\nФиксация БПЛА в направлении\nПодольск', places).direction?.to.name, 'Подольск');
  assert.equal(parsePost('БПЛА из Раменского в направлении Подольска', places).direction?.from.name, 'Раменское');
  assert.equal(parsePost('Фиксация БПЛА из Москвы в направлении Подольска', places).direction?.to.name, 'Подольск');
  assert.equal(parsePost('МО Раменское\nФиксация БПЛА в направлении неизвестного места', places).direction, null);
  assert.equal(parsePost('Раменское\nБронницы\nФиксация БПЛА в направлении Подольска', places).direction, null);
  assert.equal(parsePost('Фиксация БПЛА в направлении Подольска', places).direction, null);
});

test('additional explicit danger phrases require a recognized place', () => {
  for (const phrase of ['Работа ПВО по БПЛА', 'Фиксация БПЛА', 'Фиксации БПЛА', 'рокетная опастность', 'угроза', 'Угроза БПЛА',
    'массовые фиксации', 'Массовые фиксации БПЛА', 'Сбитие БПЛА', 'Фиксация реактивной цели', 'Фиксация группы БПЛА',
    'Внимание к возможному массовому налёту БПЛА', 'Внимание по БПЛА', 'Приготовится к возможной массовой атаки БПЛА',
    'Приготовиться к возможной массовой атаке БПЛА', 'Фиксация БПЛА в направлении', 'Фиксации БПЛА в направлении']) {
    assert.equal(parsePost(`МО Раменское\nМосковская область\n${phrase}`, places).kind, 'danger', phrase);
    assert.equal(parsePost(`Раменское — ${phrase}`, places).kind, 'danger', phrase);
    assert.equal(parsePost(phrase, places).kind, 'ignore', phrase);
  }
  assert.equal(parsePost('МО Раменское\nНет угрозы', places).kind, 'ignore');
});

test('new radar trigger phrases are treated as danger signals', () => {
  for (const phrase of ['Тревога по БПЛА', 'Внимание по БПЛА', 'Опасность по фпв', 'опасность фпв', 'Тревога по БПЛА сохраняется', 'Рой БПЛА', 'массовые сбития БПЛА', 'Сбитие БПЛА']) {
    assert.equal(parsePost(`Раменское\n${phrase}`, places).kind, 'danger', phrase);
  }
});

test('places named inside detection messages are resolved in Russian cases', () => {
  assert.equal(parsePost('Зафиксировали в Москве', places).place?.name, 'Москва');
  assert.equal(parsePost('Зафиксировали БПЛА в Раменском', places).place?.name, 'Раменское');
  assert.equal(parsePost('БПЛА зафиксировали в Подольске', places).place?.name, 'Подольск');
  assert.equal(parsePost('Зафиксировали в Московской области', places).place?.areaType, 'region');
  assert.equal(parsePost('Массовые фиксации БПЛА в Краснодарском крае', places).place?.areaType, 'region');
  assert.equal(parsePost('Фиксация БПЛА в направлении Москвы', places).place?.name, 'Москва');
  assert.equal(parsePost('Сбитие БПЛА в «Раменском»', places).place?.name, 'Раменское');
  assert.equal(parsePost('Массовые фиксации БПЛА: Раменское', places).place?.name, 'Раменское');
  assert.equal(parsePost('Сбитие БПЛА в Раменском, Подольске', places).places.length, 2);
  assert.equal(parsePost('Зафиксировали в неизвестном месте', places).kind, 'ignore');
});

test('misspelled danger and clearance still require a named settlement', () => {
  assert.equal(parsePost('Геленджик\nКраснодарский край\nОпастность по БПЛА', places).place?.name, 'Геленджик');
  assert.equal(parsePost('Раменское - ракетная опастность', places).kind, 'danger');
  assert.equal(parsePost('Геленджик\nКраснодарский край\nОтбой опастности по БПЛА', places).kind, 'clear');
  assert.equal(parsePost('Краснодарский край\nОпастность по БПЛА', places).place.areaType, 'region');
});
