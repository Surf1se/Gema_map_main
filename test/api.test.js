import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';

async function start(database = ':memory:') {
  const instance = createApp({ database, secureCookies: false });
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

async function nextCount(reader, expected) {
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`События закрылись до значения ${expected}`);
    const text = decoder.decode(value);
    for (const match of text.matchAll(/data: (\{[^\n]+\})/g)) {
      const data = JSON.parse(match[1]);
      assert.deepEqual(Object.keys(data), ['online', 'alerts', 'feedStatus']);
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
  env.applyPost({ id: 101, date, text: 'МО Раменское\nМосковская область\nОпасность по БПЛА' });
  assert.match(await nextCount(reader, 1), /"place":"Раменское"/);
  env.applyPost({ id: 101, date, text: 'МО Раменское\nСбитие БПЛА' });
  assert.match(await nextCount(reader, 1), /"alerts":\[\]/);
  env.applyPost({ id: 102, date, text: 'ГО Бронницы\nМосковская область\nРакетная опасность' });
  assert.match(await nextCount(reader, 1), /"place":"Бронницы"/);
  env.applyPost({ id: 103, date: date + 1, text: 'Московская область\nОтбой опасности по БПЛА' });
  assert.match(await nextCount(reader, 1), /"alerts":\[\]/);
  env.applyPost({ id: 102, date, text: 'ГО Бронницы\nМосковская область\nРакетная опасность' });
  assert.match(await nextCount(reader, 1), /"alerts":\[\]/);
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

test('authentication endpoints limit repeated attempts', async t => {
  const env = await start(); t.after(() => env.close()); const request = client(env.url);
  for (let i = 0; i < 20; i++) assert.equal((await request('/login', {})).status, 400);
  assert.equal((await request('/login', {})).status, 429);
});
