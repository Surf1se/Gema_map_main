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
  assert.deepEqual(parsePost('Московская область\nОтбой опасности по БПЛА', places), { kind: 'clear', place: null });
  assert.deepEqual(parsePost('Отбой', places), { kind: 'clear', place: null });
  assert.equal(parsePost('МО Раменское\nОтбой', places).place.id, 502965);
  assert.equal(parsePost('МО Раменское\nОпасность по БПЛА\nОтбой опасности по БПЛА', places).kind, 'clear');
});

test('warning expires at the next 08:00 Moscow time', () => {
  assert.equal(nextMoscowReset(Date.parse('2026-10-19T04:59:59Z')), Date.parse('2026-10-19T05:00:00Z'));
  assert.equal(nextMoscowReset(Date.parse('2026-10-19T05:00:00Z')), Date.parse('2026-10-20T05:00:00Z'));
});
