import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

// Serve only repository assets; all API calls are intercepted, no daemon or account needed.
test('now panel: mobile states, titles, resume and visible-only polling', async () => {
  const server = createServer((req, res) => {
    const module = req.url === '/markdown.mjs';
    res.setHeader('Content-Type', module ? 'text/javascript' : 'text/html');
    res.end(readFileSync(new URL(module ? '../web/markdown.mjs' : '../web/index.html', import.meta.url)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN || '/usr/bin/chromium', args: ['--no-sandbox'], headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const title = 'Очень длинное название плана по улучшению работы автопилота ' + 'безпробелов'.repeat(8);
    const task = 'Проверить перенос длинного названия задачи ' + 'задача'.repeat(15);
    const waiting = { n: 2, project: 'demo', plan: 'manual-file.md', planTitle: 'Проверка человеком', done: 0, total: 1,
      waiting: { id: 'Task 7', title: 'Проверить результат', body: '- [ ] Открыть пульт', steps: [{ n: 1, done: false }] } };
    const queue = { items: [{ n: 1, project: 'demo', plan: 'file-name.md', planTitle: title, done: 3, total: 9, waiting: null }, waiting], waiting: [waiting] };
    const views = {
      working: { kind: 'working', title: `Работает: demo — «${title}»`, details: [`Task 4 из 9: ${task}`, 'Codex gpt-6 · попытка 1 из 3 · идёт 2 мин', 'Последний вывод 10 с назад'], action: null, short: 'работает · очень-длинное-имя-проекта Task 4' },
      user: { kind: 'user', title: 'Ничего не делает: все планы в очереди ждут тебя (1)', details: [`demo — «${title}», Task 7: ${task}`], action: null, short: 'ждёт тебя (1)' },
      stuck: { kind: 'stuck', title: 'Остановился: исчерпаны попытки', details: [`Задача Task 4 в «${title}»`], action: 'resume', short: 'остановился' },
      down: { kind: 'down', title: 'Автопилот не отвечает с 12:10', details: ['Служба остановлена или зависла. Напиши планировщику «проверь автопилот».'], action: null, short: 'не отвечает' },
    };
    let view = views.working;
    let nowRequests = 0;
    let nowFails = false;
    const commands = [];
    await page.addInitScript(() => {
      const interval = window.setInterval;
      window.__polls = [];
      window.setInterval = (callback, ms, ...args) => {
        window.__polls.push({ callback, ms });
        return interval(callback, ms, ...args);
      };
    });
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      let data = {};
      if (path === '/api/now') {
        nowRequests++;
        if (nowFails) return route.fulfill({ status: 503, json: { error: 'Сервер недоступен' } });
        data = view;
      }
      if (path === '/api/queue') data = view.kind === 'user' ? { items: [waiting], waiting: [waiting] } : queue;
      if (path === '/api/status') data = { text: 'legacy status', state: { status: 'running' } };
      if (path === '/api/history') data = { entries: [], busy: false };
      if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' });
      if (path === '/api/command') { commands.push(route.request().postDataJSON()); data = { ok: true }; }
      if (path === '/api/projects') data = [{ name: 'demo', active: false, currentPlan: 'file-name.md', plans: [{ planPath: 'file-name.md', planTitle: title, done: 3, total: 9 }] }];
      if (path === '/api/plan') data = { markdown: '', tasks: [] };
      return route.fulfill({ json: data });
    });
    for (const width of [360, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const kind of Object.keys(views)) {
        view = views[kind];
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.locator('[data-tab="status"]').click();
        await page.waitForFunction(text => document.querySelector('#now-title').textContent === text, view.title);
        assert.equal(await page.locator('#pill-text').textContent(), view.short);
        assert.equal(await page.locator('#dot').getAttribute('class'), `dot ${kind}`);
        assert.equal(await page.locator('#now-resume').isVisible(), kind === 'stuck');
        assert.deepEqual(await page.locator('#now-details p').allTextContents(), view.details);
        assert.equal(await page.locator('#next-queue .qrow').count(), kind === 'user' ? 0 : 1);
        if (kind !== 'user') assert.ok((await page.locator('#next-queue').textContent()).includes(title));
        assert.equal(await page.locator('#waiting .wplan').getAttribute('title'), 'manual-file.md');
        const layout = await page.evaluate(() => {
          const nodes = [...document.querySelectorAll('#now, #now h2, #now-details p, #next-queue, #waiting, header')];
          return { overflow: nodes.some(n => n.scrollWidth > n.clientWidth + 1 || n.getBoundingClientRect().right > innerWidth),
            ellipsis: getComputedStyle(document.querySelector('#pill-text')).textOverflow,
            first: document.querySelector('#tab-status .scroll').firstElementChild.id };
        });
        assert.deepEqual(layout, { overflow: false, ellipsis: 'ellipsis', first: 'now' });
        if (process.env.NOW_SCREENSHOTS) await page.screenshot({ path: `docs/plans/2026-11-07-now-${kind}-${width}.png` });
      }
    }
    for (const kind of ['working', 'down']) {
      view = views[kind];
      await page.locator('#status-refresh').click();
      await page.waitForFunction(text => document.querySelector('#now-title').textContent === text, view.title);
      assert.equal(await page.locator('#pill-text').textContent(), view.short);
    }
    nowFails = true;
    await page.locator('#status-refresh').click();
    await page.waitForFunction(() => document.querySelector('#now-title').textContent === 'Не удалось получить статус');
    assert.equal(await page.locator('#pill-text').textContent(), 'не отвечает');
    assert.equal(await page.locator('#now-resume').isVisible(), false);
    nowFails = false;
    view = views.stuck;
    await page.locator('#status-refresh').click();
    await page.locator('#now-resume').waitFor({ state: 'visible' });
    await page.locator('#now-resume').click();
    await page.waitForFunction(() => document.querySelector('#cmd-note').textContent.includes('отправлена'));
    assert.deepEqual(commands, [{ cmd: 'resume' }]);
    const before = nowRequests;
    view = views.user;
    await page.evaluate(() => {
      const poll = window.__polls.find(p => p.ms === 15000);
      if (!poll) throw new Error('15 second polling missing');
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      poll.callback();
    });
    await page.waitForTimeout(100);
    assert.equal(nowRequests, before);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      window.__polls.find(p => p.ms === 15000).callback();
    });
    await page.waitForFunction(() => document.querySelector('#pill-text').textContent === 'ждёт тебя (1)');
    assert.ok(nowRequests > before);
    await page.locator('[data-tab="plan"]').click();
    await page.locator('.card-head').click();
    await page.locator('.plan-toggle').waitFor();
    assert.ok((await page.locator('.card-head').textContent()).includes(title));
    assert.ok((await page.locator('.plan-toggle').textContent()).includes(title));
    assert.equal(await page.locator('.plan-toggle').getAttribute('title'), 'file-name.md');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
