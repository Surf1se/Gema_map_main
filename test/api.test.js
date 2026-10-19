import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.js';

async function start(database = ':memory:', options = {}) {
  const instance = createApp({ database, secureCookies: false, boundaryLookup: async () => null, ...options });
  const server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, applyPost: instance.applyPost, async close() { instance.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
function client(url) {
  let cookie = '';
  return async (path, body, extra = {}) => {
    const response = await fetch(url + '/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  };
}
const account = (email = 'alice@example.com') => ({ email, password: 'correct horse battery', name: 'Алиса' });

test('map configuration enables Yandex only with a Tiles API key', async t => {
  const withoutKey = await start(':memory:', { yandexTilesKey: '' });
  t.after(() => withoutKey.close());
  assert.deepEqual(await (await fetch(withoutKey.url + '/api/map-config')).json(), { provider: 'openstreetmap' });
  const withKey = await start(':memory:', { yandexTilesKey: 'test-tiles-key' });
  t.after(() => withKey.close());
  const response = await fetch(withKey.url + '/api/map-config');
  assert.deepEqual(await response.json(), { provider: 'yandex', key: 'test-tiles-key' });
  assert.match(response.headers.get('content-security-policy'), /tiles\.api-maps\.yandex\.ru/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

async function nextCount(reader, expected) {
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`События закрылись до значения ${expected}`);
    const text = decoder.decode(value);
    for (const match of text.matchAll(/data: (\{[^\n]+\})/g)) {
      const data = JSON.parse(match[1]);
      assert.deepEqual(Object.keys(data), ['online', 'alerts', 'clearances', 'feedStatus']);
      if (data.online === expected) return text;
    }
  }
}

test('registration needs no location consent and sessions remain protected', async t => {
  const env = await start(); t.after(() => env.close()); const request = client(env.url);
  assert.equal((await request('/me')).status, 401);
  assert.equal((await request('/register', { ...account(), name: '' })).status, 400);
  const response = await request('/register', account());
  assert.equal(response.status, 201);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(response.headers.get('set-cookie'), /SameSite=Strict/);
  assert.deepEqual(Object.keys((await response.json()).user).sort(), ['id', 'name']);
  assert.equal((await (await request('/me')).json()).user.name, 'Алиса');
  assert.equal((await request('/register', account())).status, 409);
  assert.equal((await request('/login', { ...account(), password: 'wrong password' })).status, 401);
  assert.equal((await request('/login', account())).status, 200);
});

test('online count tracks unique connected accounts without identity data', async t => {
  const env = await start(); t.after(() => env.close());
  const alice = client(env.url), bob = client(env.url), guest = client(env.url);
  await alice('/register', account());
  await bob('/register', { ...account('bob@example.com'), name: 'Боб' });
  assert.equal((await guest('/events')).status, 401);
  const aliceReader = (await alice('/events')).body.getReader(); t.after(() => aliceReader.cancel().catch(() => {}));
  assert.doesNotMatch(await nextCount(aliceReader, 1), /Алиса|Боб|email|password|token/);
  const secondTabReader = (await alice('/events')).body.getReader(); t.after(() => secondTabReader.cancel().catch(() => {}));
  await nextCount(secondTabReader, 1);
  const bobReader = (await bob('/events')).body.getReader(); t.after(() => bobReader.cancel().catch(() => {}));
  assert.doesNotMatch(await nextCount(aliceReader, 2), /Алиса|Боб|email|password|token/);
  await nextCount(bobReader, 2);
  await bobReader.cancel();
  await nextCount(aliceReader, 1);
  assert.equal((await alice('/location', { latitude: 55, longitude: 37 })).status, 404);
  assert.equal((await alice('/location/stop', {})).status, 404);
});

test('danger, edits and clear messages update the map feed', async t => {
  const env = await start(); t.after(() => env.close()); const request = client(env.url);
  await request('/register', account());
  const reader = (await request('/events')).body.getReader(); t.after(() => reader.cancel().catch(() => {}));
  assert.match(await nextCount(reader, 1), /"alerts":\[\]/);
  const date = Date.now();
  const publishedAt = date - 60_000;
  env.applyPost({ id: 101, date, publishedAt, text: 'МО Раменское\nМосковская область\nОпасность по БПЛА' });
  const firstDanger = await nextCount(reader, 1);
  assert.match(firstDanger, /"place":"Раменское"/);
  assert.match(firstDanger, new RegExp(`"publishedAt":${publishedAt}`));
  env.applyPost({ id: 101, date: date + 1, publishedAt, text: 'МО Раменское\nСбитие БПЛА' });
  const updated = await nextCount(reader, 1);
  assert.match(updated, /"place":"Раменское"/);
  assert.match(updated, new RegExp(`"observedAt":${date + 1},"publishedAt":${publishedAt}`));
  env.applyPost({ id: 101, date: date + 2, text: 'МО Раменское\nСводка за день' });
  assert.match(await nextCount(reader, 1), /"alerts":\[\]/);
  env.applyPost({ id: 102, date, text: 'ГО Бронницы\nМосковская область\nРакетная опасность' });
  assert.match(await nextCount(reader, 1), /"place":"Бронницы"/);
  env.applyPost({ id: 103, date: date + 1, text: 'Московская область\nОтбой опасности по БПЛА' });
  assert.match(await nextCount(reader, 1), /"alerts":\[\]/);
  env.applyPost({ id: 102, date, text: 'ГО Бронницы\nМосковская область\nРакетная опасность' });
  assert.match(await nextCount(reader, 1), /"alerts":\[\]/);
});

test('detection messages refresh the named city or region', async t => {
  const env = await start(); t.after(() => env.close()); const request = client(env.url);
  await request('/register', account());
  const reader = (await request('/events')).body.getReader(); t.after(() => reader.cancel().catch(() => {}));
  await nextCount(reader, 1);
  const date = Date.now();
  const snapshot = async () => JSON.parse((await nextCount(reader, 1)).match(/data: (\{[^\n]+\})/u)[1]);
  env.applyPost({ id: 301, date, text: 'Московская область\nОпасность по БПЛА' });
  assert.equal((await snapshot()).alerts[0].areaType, 'region');
  env.applyPost({ id: 302, date: date + 1, text: 'Массовые фиксации в Московской области' });
  const region = await snapshot();
  assert.equal(region.alerts[0].areaType, 'region');
  assert.equal(region.alerts[0].observedAt, date + 1);
  env.applyPost({ id: 303, date: date + 2, text: 'Зафиксировали в Раменском' });
  const city = await snapshot();
  assert.equal(city.alerts[0].place, 'Раменское');
  assert.equal(city.alerts[0].observedAt, date + 2);
});

test('district and region warnings clear at the intended scope', async t => {
  const env = await start(); t.after(() => env.close()); const request = client(env.url);
  await request('/register', account());
  const reader = (await request('/events')).body.getReader(); t.after(() => reader.cancel().catch(() => {}));
  await nextCount(reader, 1);
  const date = Date.now();
  env.applyPost({ id: 201, date, text: 'Знаменский район\nОрловская область\nОпасность по БПЛА' });
  assert.match(await nextCount(reader, 1), /"areaType":"district"/);
  env.applyPost({ id: 202, date: date + 1, text: 'Орловская область\nОпасность по БПЛА' });
  const both = await nextCount(reader, 1);
  assert.match(both, /"areaType":"region"/);
  assert.match(both, /"areaType":"district"/);
  env.applyPost({ id: 203, date: date + 2, text: 'Знаменский район\nОрловская область\nОтбой' });
  const districtClear = await nextCount(reader, 1);
  assert.match(districtClear, /"alerts":\[\{"placeId"[^\]]*"areaType":"region"/);
  assert.match(districtClear, /"clearances":\[\{"placeId"[^\]]*"areaType":"district"/);
  env.applyPost({ id: 204, date: date + 3, text: 'Орловская область\nОтбой' });
  assert.match(await nextCount(reader, 1), /"alerts":\[\]/);
  env.applyPost({ id: 202, date: date + 1, text: 'Орловская область\nОпасность по БПЛА' });
  assert.match(await nextCount(reader, 1), /"alerts":\[\]/);
});

test('channels use separate message IDs and region clearances', async t => {
  const env = await start(); t.after(() => env.close()); const request = client(env.url);
  await request('/register', account());
  const reader = (await request('/events')).body.getReader(); t.after(() => reader.cancel().catch(() => {}));
  await nextCount(reader, 1);
  const date = Date.now();
  const danger = 'Геленджик\nКраснодарский край\nОпасность по БПЛА';
  env.applyPost({ source: 'radar_moscoww', id: 101, date, text: danger });
  await nextCount(reader, 1);
  env.applyPost({ source: 'radarrussiia', id: 101, date, text: danger });
  const both = await nextCount(reader, 1);
  assert.match(both, /"source":"radarrussiia"/);
  assert.match(both, /"source":"radar_moscoww"/);
  env.applyPost({ source: 'radarrussiia', id: 102, date: date + 1, text: 'Краснодарский край\nОтбой опасности по БПЛА' });
  const one = await nextCount(reader, 1);
  assert.match(one, /"source":"radar_moscoww"/);
  assert.doesNotMatch(one, /"source":"radarrussiia"/);
  env.applyPost({ source: 'radarrussiia', id: 101, date, text: danger });
  assert.doesNotMatch(await nextCount(reader, 1), /"source":"radarrussiia"/);
  env.applyPost({ source: 'radarrussiia', id: 103, date: date + 2, text: 'Анапа\nКраснодарский край\nОпасность по БПЛА' });
  assert.match(await nextCount(reader, 1), /"place":"Анапа"/);
  env.applyPost({ source: 'radarrussiia', id: 104, date: date + 3, text: 'Геленджик\nАнапа\nНовороссийск\nКраснодарский край\nОпасность по БПЛА' });
  const multiple = await nextCount(reader, 1);
  assert.match(multiple, /"place":"Новороссийск"/);
  assert.match(multiple, /"place":"Анапа"/);
  assert.match(multiple, /"place":"Геленджик"/);
});

test('existing alerts and clearances migrate to the first channel', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gema-legacy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'legacy.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec('CREATE TABLE alerts (message_id TEXT PRIMARY KEY, place_id INTEGER NOT NULL, place_name TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL, radius INTEGER NOT NULL, observed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL); CREATE TABLE alert_clearances (place_id TEXT PRIMARY KEY, cleared_at INTEGER NOT NULL)');
  legacy.prepare('INSERT INTO alerts VALUES (?,?,?,?,?,?,?,?)').run('101', 502965, 'Раменское', 55.56, 38.23, 5000, Date.now(), Date.now() + 86_400_000);
  legacy.prepare('INSERT INTO alert_clearances VALUES (?,?)').run('*', Date.now() - 1000);
  legacy.close();
  const app = createApp({ database: path });
  app.close();
  const migrated = new DatabaseSync(path);
  const alert = migrated.prepare('SELECT message_id,region_code FROM alerts').get();
  assert.equal(alert.message_id, 'radar_moscoww:101:502965');
  assert.equal(alert.region_code, '47');
  assert.ok(migrated.prepare('SELECT published_at FROM alerts').get().published_at > 0);
  assert.match(migrated.prepare('SELECT place_id FROM alert_clearances').get().place_id, /^radar_moscoww:\*$/);
  migrated.close();
});

test('cross-site writes are rejected and logout revokes the session', async t => {
  const env = await start(); t.after(() => env.close()); const request = client(env.url); await request('/register', account());
  assert.equal((await request('/logout', {}, { Origin: 'https://another.example' })).status, 403);
  assert.equal((await request('/logout', {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await request('/logout', {})).status, 204);
  assert.equal((await request('/me')).status, 401);
});

test('accounts survive restart while online count starts from active connections', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'gema-test-'));
  let second;
  t.after(async () => { await second?.close(); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, 'test.sqlite');
  const first = await start(path); const alice = client(first.url);
  await alice('/register', account());
  const firstReader = (await alice('/events')).body.getReader();
  await nextCount(firstReader, 1);
  await firstReader.cancel();
  await first.close();
  second = await start(path); const request = client(second.url);
  assert.equal((await request('/login', account())).status, 200);
  const response = await request('/events'); const reader = response.body.getReader();
  await nextCount(reader, 1);
  await reader.cancel();
});

test('recent clearances survive restart and expired ones are removed', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'gema-clear-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'test.sqlite');
  const first = createApp({ database: path, boundaryLookup: async () => null });
  const date = Date.now();
  first.applyPost({ id: 701, date, text: 'МО Раменское\nМосковская область\nОпасность по БПЛА' });
  first.applyPost({ id: 702, date: date + 1, text: 'МО Раменское\nМосковская область\nОтбой' });
  first.close();
  const second = createApp({ database: path, boundaryLookup: async () => null });
  second.close();
  const db = new DatabaseSync(path);
  const clearance = db.prepare('SELECT place_name,expires_at FROM recent_clearances').get();
  assert.equal(clearance.place_name, 'Раменское');
  assert.equal(clearance.expires_at, date + 1 + 5 * 60_000);
  db.prepare('UPDATE recent_clearances SET expires_at=?').run(Date.now() - 1);
  db.close();
  const third = createApp({ database: path, boundaryLookup: async () => null });
  third.close();
  const verified = new DatabaseSync(path);
  assert.equal(verified.prepare('SELECT count(*) AS count FROM recent_clearances').get().count, 0);
  verified.close();
});

test('authentication endpoints limit repeated attempts', async t => {
  const env = await start(); t.after(() => env.close()); const request = client(env.url);
  for (let i = 0; i < 20; i++) assert.equal((await request('/login', {})).status, 400);
  assert.equal((await request('/login', {})).status, 429);
});
