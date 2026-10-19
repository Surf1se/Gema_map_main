import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPlaceIndex, nextMoscowReset, parsePost } from '../lib/alerts.js';

const places = loadPlaceIndex();

test('explicit danger identifies the intended settlement, not a similarly named village', () => {
  const result = parsePost('МО Раменское\nМосковская область\nОпасность по БПЛА\nМеры безопасности', places);
  assert.equal(result.kind, 'danger');
  assert.equal(result.place.id, 502965);
  assert.equal(parsePost('ГО Бронницы\nМосковская область\nРакетная опасность', places).place.name, 'Бронницы');
});

test('news, predictions and region-only warnings do not create city circles', () => {
  for (const text of [
    'МО Раменское\nСбитие БПЛА',
    'МО Раменское\nПрогноз ракетной опасности на ночь',
    'Московская область\nОпасность по БПЛА',
    'МО Раменское\nОпасности по БПЛА нет',
    'Раменское\nВозможная опасность по БПЛА'
  ]) assert.equal(parsePost(text, places).kind, 'ignore', text);
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
  assert.equal(parsePost('Геленджик\nКраснодарский край\nТревога по БПЛА', places).kind, 'danger');
  assert.equal(parsePost('Краснодарский край\nОпасность по БПЛА', places).kind, 'ignore');
  assert.equal(parsePost('За ночь сбито 149 БПЛА над Кубанью', places).kind, 'ignore');
  assert.equal(parsePost('Знаменский район\nОрловская область\nФиксация БПЛА', places).kind, 'ignore');
});

test('misspelled danger and clearance still require a named settlement', () => {
  assert.equal(parsePost('Геленджик\nКраснодарский край\nОпастность по БПЛА', places).place?.name, 'Геленджик');
  assert.equal(parsePost('Раменское - ракетная опастность', places).kind, 'danger');
  assert.equal(parsePost('Геленджик\nКраснодарский край\nОтбой опастности по БПЛА', places).kind, 'clear');
  assert.equal(parsePost('Краснодарский край\nОпастность по БПЛА', places).kind, 'ignore');
});

test('warning expires at the next 08:00 Moscow time', () => {
  assert.equal(nextMoscowReset(Date.parse('2026-10-19T04:59:59Z')), Date.parse('2026-10-19T05:00:00Z'));
  assert.equal(nextMoscowReset(Date.parse('2026-10-19T05:00:00Z')), Date.parse('2026-10-20T05:00:00Z'));
});
