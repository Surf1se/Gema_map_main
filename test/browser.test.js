import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { createApp } from '../server.js';

test('two browsers share positions, stop sharing, sign out, and work on mobile', { timeout: 60_000 }, async t => {
  const instance = createApp({ database: ':memory:', secureCookies: false });
  const server = instance.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); instance.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  async function participant(name, email, geolocation, mobile = false) {
    const context = await browser.newContext({ permissions: ['geolocation'], geolocation, ...(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 1000 } }) });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.locator('#auth-dialog').waitFor({ state: 'visible' });
    await page.locator('#name').fill(name); await page.locator('#email').fill(email); await page.locator('#password').fill('correct horse battery'); await page.locator('#consent').check();
    await page.locator('#auth-submit').click();
    await page.locator('#auth-dialog').waitFor({ state: 'hidden' });
    return { page, context };
  }
  const alice = await participant('Алиса', 'alice@example.com', { latitude: 55.75, longitude: 37.62, accuracy: 20_000 });
  const bob = await participant('Боб', 'bob@example.com', { latitude: 55.76, longitude: 37.63, accuracy: 20 }, true);
  await alice.page.locator('#share-button').click(); await bob.page.locator('#share-button').click();
  await alice.page.waitForFunction(() => document.querySelector('#notice').textContent.includes('±20000 м'));
  await bob.page.waitForFunction(() => document.querySelector('#people-count').textContent === '1');
  assert.doesNotMatch(await bob.page.locator('#people').textContent(), /Алиса/);
  await alice.context.setGeolocation({ latitude: 55.75, longitude: 37.62, accuracy: 15 });
  for (const { page } of [alice, bob]) {
    await page.waitForFunction(() => document.querySelector('#people-count').textContent === '2');
    assert.equal(await page.locator('.pin-avatar').count(), 2);
    assert.equal(await page.locator('.pin-avatar.self').count(), 1);
    assert.equal(await page.locator('#people .person').count(), 2);
  }
  await alice.page.screenshot({ path: '/tmp/gema-desktop.png' });
  await bob.page.screenshot({ path: '/tmp/gema-mobile.png' });
  assert.equal(await bob.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const movement = alice.page.waitForResponse(r => r.url().endsWith('/api/location') && r.request().method() === 'POST');
  await alice.context.setGeolocation({ latitude: 55.77, longitude: 37.65, accuracy: 8 });
  assert.equal((await movement).status(), 204);
  await bob.page.waitForFunction(() => document.querySelector('#people').textContent.includes('±8 м'));
  await alice.page.locator('#share-button').click();
  await bob.page.waitForFunction(() => document.querySelector('#people-count').textContent === '1');
  assert.doesNotMatch(await bob.page.locator('#people').textContent(), /Алиса/);
  await bob.page.locator('#logout').click();
  await bob.page.locator('#auth-dialog').waitFor({ state: 'visible' });
  await alice.page.waitForFunction(() => document.querySelector('#people-count').textContent === '0');
  await bob.page.locator('#login-tab').click();
  await bob.page.locator('#email').fill('bob@example.com'); await bob.page.locator('#password').fill('correct horse battery'); await bob.page.locator('#auth-submit').click();
  await bob.page.locator('#auth-dialog').waitFor({ state: 'hidden' });
  assert.equal(await bob.page.locator('#profile-name').textContent(), 'Боб');
  await bob.page.reload();
  await bob.page.waitForFunction(() => document.querySelector('#profile-name').textContent === 'Боб');
  assert.equal(await bob.page.locator('#auth-dialog').isVisible(), false);
  await alice.context.clearPermissions();
  await alice.page.locator('#share-button').click();
  await alice.page.waitForFunction(() => document.querySelector('#notice').textContent.includes('запрещён'));
  assert.match(await alice.page.locator('#share-button').textContent(), /Включить/);
  assert.deepEqual(errors, []);
});
