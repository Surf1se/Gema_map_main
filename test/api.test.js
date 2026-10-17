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
  return { url: `http://127.0.0.1:${server.address().port}`, async close() { instance.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
function client(url) {
  let cookie = '';
  return async (path, body, extra = {}) => {
    const response = await fetch(url + '/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  };
}
const account = (email = 'alice@example.com') => ({ email, password: 'correct horse battery', name: 'Алиса', sharingConsent: true });

test('registration requires consent, hashes credentials and authenticates via cookie', async t => {
  const env = await start(); t.after(() => env.close()); const request = client(env.url);
  assert.equal((await request('/me')).status, 401);
  assert.equal((await request('/register', { ...account(), sharingConsent: false })).status, 400);
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

test('a second user receives live coordinates and removal over SSE; guests cannot read or send', async t => {
  const env = await start(); t.after(() => env.close());
  const alice = client(env.url), bob = client(env.url), guest = client(env.url);
  await alice('/register', account());
  await bob('/register', { ...account('bob@example.com'), name: 'Боб' });
  assert.equal((await guest('/events')).status, 401);
  assert.equal((await guest('/location', {})).status, 401);
  const response = await bob('/events');
  assert.equal(response.status, 200);
  const reader = response.body.getReader(); t.after(() => reader.cancel().catch(() => {}));
  const initial = new TextDecoder().decode((await reader.read()).value);
  assert.match(initial, /"positions":\[\]/);
  const location = { latitude: 55.75, longitude: 37.62, accuracy: 12, observedAt: Date.now() };
  assert.equal((await alice('/location', location)).status, 204);
  const update = new TextDecoder().decode((await reader.read()).value);
  assert.match(update, /55.75/); assert.match(update, /Алиса/); assert.doesNotMatch(update, /email|password|token/);
  assert.equal((await alice('/location/stop', {})).status, 204);
  assert.match(new TextDecoder().decode((await reader.read()).value), /"positions":\[\]/);
});

test('invalid, stale and future coordinates are rejected', async t => {
  const env = await start(); t.after(() => env.close()); const request = client(env.url); await request('/register', account());
  const valid = { latitude: 0, longitude: 0, accuracy: 10, observedAt: Date.now() };
  for (const change of [{ latitude: 91 }, { longitude: -181 }, { accuracy: -1 }, { latitude: '55' }, { observedAt: Date.now() - 70_000 }, { observedAt: Date.now() + 60_000 }]) {
    assert.equal((await request('/location', { ...valid, ...change })).status, 400);
  }
  assert.equal((await request('/location', valid)).status, 204);
});

test('cross-site writes are rejected and logout revokes the session', async t => {
  const env = await start(); t.after(() => env.close()); const request = client(env.url); await request('/register', account());
  assert.equal((await request('/location/stop', {}, { Origin: 'https://another.example' })).status, 403);
  assert.equal((await request('/location/stop', {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await request('/logout', {})).status, 204);
  assert.equal((await request('/me')).status, 401);
});

test('accounts survive restart but location history is not persisted', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'gema-test-'));
  let second;
  t.after(async () => { await second?.close(); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, 'test.sqlite');
  const first = await start(path); const alice = client(first.url);
  await alice('/register', account()); await alice('/location', { latitude: 10, longitude: 20, accuracy: 5, observedAt: Date.now() });
  await first.close();
  second = await start(path); const request = client(second.url);
  assert.equal((await request('/login', account())).status, 200);
  const response = await request('/events'); const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /"positions":\[\]/);
  await reader.cancel();
});

test('authentication endpoints limit repeated attempts', async t => {
  const env = await start(); t.after(() => env.close()); const request = client(env.url);
  for (let i = 0; i < 20; i++) assert.equal((await request('/login', {})).status, 400);
  assert.equal((await request('/login', {})).status, 429);
});
