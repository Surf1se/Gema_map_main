import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { createApp } from '../server.js';

test('map stays visible while online count follows users on desktop and mobile', { timeout: 60_000 }, async t => {
  const instance = createApp({ database: ':memory:', secureCookies: false });
  const server = instance.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); instance.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  const locationRequests = [];
  async function participant(name, email, mobile = false) {
    const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().includes('/api/location')) locationRequests.push(request.url()); });
    await page.goto(url);
    await page.locator('#auth-dialog').waitFor({ state: 'visible' });
    await page.locator('#name').fill(name); await page.locator('#email').fill(email); await page.locator('#password').fill('correct horse battery');
    await page.locator('#auth-submit').click();
    await page.locator('#auth-dialog').waitFor({ state: 'hidden' });
    return { page, context };
  }
  const alice = await participant('Алиса', 'alice@example.com');
  await alice.page.waitForFunction(() => document.querySelector('#online-count').textContent === '1');
  assert.equal(await alice.page.locator('#map .leaflet-pane').count() > 0, true);
  const bob = await participant('Боб', 'bob@example.com', true);
  for (const { page } of [alice, bob]) {
    await page.waitForFunction(() => document.querySelector('#online-count').textContent === '2');
    assert.equal(await page.locator('#map .leaflet-pane').count() > 0, true);
    assert.equal(await page.locator('.map-pin').count(), 0);
    assert.doesNotMatch(await page.locator('.online-card').textContent(), /Алиса|Боб|@/);
  }
  instance.applyPost({ id: 123, date: Date.now(), text: 'МО Раменское\nМосковская область\nОпасность по БПЛА' });
  await alice.page.waitForFunction(() => document.querySelector('#alerts-count').textContent.includes('1'));
  assert.equal(await alice.page.locator('#map path.leaflet-interactive').count(), 1);
  instance.applyPost({ id: 124, date: Date.now(), text: 'Московская область\nОтбой опасности по БПЛА' });
  await alice.page.waitForFunction(() => document.querySelector('#alerts-count').textContent.includes('0'));
  assert.equal(await alice.page.locator('#map path.leaflet-interactive').count(), 0);
  assert.equal(await bob.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const secondTab = await alice.context.newPage(); await secondTab.goto(url);
  await secondTab.waitForFunction(() => document.querySelector('#online-count').textContent === '2');
  await secondTab.close();
  await bob.page.locator('#logout').click();
  await bob.page.locator('#auth-dialog').waitFor({ state: 'visible' });
  await alice.page.waitForFunction(() => document.querySelector('#online-count').textContent === '1');
  await bob.page.locator('#login-tab').click();
  await bob.page.locator('#email').fill('bob@example.com'); await bob.page.locator('#password').fill('correct horse battery'); await bob.page.locator('#auth-submit').click();
  await bob.page.locator('#auth-dialog').waitFor({ state: 'hidden' });
  await bob.page.waitForFunction(() => document.querySelector('#online-count').textContent === '2');
  await bob.page.reload();
  await bob.page.waitForFunction(() => document.querySelector('#online-count').textContent === '2');
  assert.equal(await bob.page.locator('#auth-dialog').isVisible(), false);
  assert.deepEqual(locationRequests, []);
  assert.deepEqual(errors, []);
});
