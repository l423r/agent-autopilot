#!/usr/bin/env node
// Visual check of the panel: starts the server with a fake planner and a fake ntfy, drives Chromium at phone size
// and saves docs/screenshots/web-<screen>.png. Fails on a console error, horizontal scrolling or script injection.
// Usage: node scripts/web-screenshots.mjs [planFile]   (default: the sigaret-counter plan)
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../web/server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLAN = process.argv[2] ?? '/root/sigaret-counter/docs/superpowers/plans/2026-10-20-sigaret-counter-app.md';
const OUT = join(ROOT, 'docs', 'screenshots');
const CHROMIUM = process.env.CHROMIUM ?? '/usr/bin/chromium';

// The answer exercises every renderer path that can break the layout, plus two injection attempts.
const ANSWER = [
  '### План на сегодня\n\n',
  'Вот что **осталось** в работе:\n\n- Task 7: *ревью кода*\n- Task 8: установка с `телефона`\n\n',
  '```js\nconst veryLongLine = "' + 'x'.repeat(160) + '";\nconsole.log(veryLongLine);\n```\n\n',
  'Длинная строка: ' + 'ОченьДлинноеСловоБезПробелов'.repeat(6) + '\n\n',
  '<script>window.__xss = 1</script> <img src=x onerror="window.__xss = 1"> [ссылка](javascript:window.__xss=1)\n',
];

const failures = [];
const fail = msg => { failures.push(msg); console.error(`✗ ${msg}`); };

const work = mkdtempSync(join(tmpdir(), 'pult-shots-'));
const projectDir = join(work, 'project');
mkdirSync(projectDir);
copyFileSync(PLAN, join(projectDir, 'plan.md'));
const stateDir = join(work, 'state');
mkdirSync(stateDir);
writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ status: 'running', currentTask: 'Task 7' }));

const ntfyBodies = [];
const ntfy = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => { ntfyBodies.push({ url: req.url, auth: req.headers.authorization, body }); res.end('{}'); });
});
await new Promise(r => ntfy.listen(0, '127.0.0.1', r));

process.env.FAKE_STREAM = 'slow';
process.env.FAKE_PARTS = JSON.stringify(ANSWER);
const cfg = {
  projectDir, planPath: 'plan.md', stateDir, autopilotDir: ROOT,
  ntfyServer: `http://127.0.0.1:${ntfy.address().port}`, ntfyTopic: 'shots', ntfyCommandToken: 'tk_shots', ntfyCommands: true,
};
const server = await startServer(cfg, { port: 0, claudeBin: join(ROOT, 'test', 'fixtures', 'fake-claude-stream.mjs') });
const url = `http://127.0.0.1:${server.port}/`;

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.on('console', m => { if (m.type() === 'error') fail(`консоль: ${m.text()}`); });
  page.on('response', r => { if (r.status() >= 400) fail(`HTTP ${r.status()}: ${new URL(r.url()).pathname}`); });
  page.on('pageerror', e => fail(`ошибка страницы: ${e.message}`));
  page.on('dialog', d => d.accept());
  mkdirSync(OUT, { recursive: true });

  const check = async name => {
    const problems = await page.evaluate(() => {
      const out = [];
      const de = document.documentElement;
      if (de.scrollWidth > de.clientWidth) out.push(`страница шире экрана: ${de.scrollWidth} > ${de.clientWidth}`);
      for (const n of document.querySelectorAll('main section.active .scroll, main section.active .composer')) {
        if (n.scrollWidth > n.clientWidth + 1) out.push(`${n.className} прокручивается вбок: ${n.scrollWidth} > ${n.clientWidth}`);
      }
      for (const b of document.querySelectorAll('button')) {
        const r = b.getBoundingClientRect();
        if (r.width && r.height && b.offsetParent && r.height < 44) out.push(`кнопка «${b.textContent.trim()}» высотой ${r.height}px`);
      }
      if (window.__xss) out.push('исполнен скрипт из ответа');
      return out;
    });
    for (const p of problems) fail(`${name}: ${p}`);
  };
  const shot = async name => {
    // Finite transitions (the progress bar) must settle, or the picture shows a half-drawn state.
    await page.evaluate(() => Promise.all(document.getAnimations()
      .filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)));
    await check(name);
    await page.screenshot({ path: join(OUT, `web-${name}.png`) });
    console.log(`✓ web-${name}.png`);
  };

  await page.goto(url);
  await page.waitForSelector('#msgs .empty');
  await page.waitForFunction(() => document.getElementById('pill-text').textContent !== '…');
  await shot('chat-empty');

  await page.fill('#input', 'Какие у нас проекты и что в работе?');
  await page.click('#send-btn');
  await page.waitForFunction(() => document.querySelector('.msg.streaming')?.textContent.includes('осталось'));
  await shot('chat-streaming');

  await page.waitForSelector('.msg.assistant:not(.streaming)', { timeout: 15_000 });
  await page.waitForSelector('#send-btn:not(.hidden)');
  await page.evaluate(() => { const s = document.getElementById('chat-scroll'); s.scrollTop = s.scrollHeight; });
  const pre = await page.evaluate(() => {
    const p = document.querySelector('.msg.assistant pre');
    return p && { scrolls: p.scrollWidth > p.clientWidth, fits: p.getBoundingClientRect().right <= innerWidth };
  });
  if (!pre?.scrolls || !pre.fits) fail(`блок кода должен прокручиваться внутри себя: ${JSON.stringify(pre)}`);
  if (!(await page.evaluate(() => document.querySelector('.msg.assistant').textContent.includes('<script>')))) {
    fail('<script> из ответа должен остаться видимым текстом');
  }
  if (await page.evaluate(() => [...document.querySelectorAll('.msg.assistant a')].some(a => /^javascript:/i.test(a.getAttribute('href'))))) {
    fail('javascript:-ссылка стала ссылкой');
  }
  await shot('chat-answer');

  // `@` opens the project picker above the field; a tap inserts `@name `, the sent message highlights it.
  await page.fill('#input', '');
  await page.type('#input', 'Что с @pro');
  await page.waitForSelector('#mentions:not(.hidden) button');
  await shot('chat-mention');
  await page.click('#mentions button');
  const typed = await page.inputValue('#input');
  if (typed !== 'Что с @project ') fail(`после выбора проекта в поле «${typed}»`);
  if (await page.isVisible('#mentions')) fail('список проектов не закрылся после выбора');
  await page.type('#input', 'и a@mail.ru?');
  await page.click('#send-btn');
  await page.waitForSelector('#send-btn:not(.hidden)', { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelectorAll('.msg.assistant:not(.streaming)').length === 2, null, { timeout: 15_000 });
  const marks = await page.evaluate(() => [...document.querySelectorAll('.msg.user')].at(-1).querySelectorAll('.mention').length);
  if (marks !== 1) fail(`в сообщении подсвечено упоминаний: ${marks}, нужно 1`);

  // 📎: a big picture is shrunk to 2000 px JPEG, uploaded, shown above the field; it can go without text.
  const bigPng = await page.evaluate(async () => {
    const c = Object.assign(document.createElement('canvas'), { width: 3000, height: 1600 });
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 3000, 1600);
    grad.addColorStop(0, '#7b3cff');
    grad.addColorStop(1, '#3ecf8e');
    g.fillStyle = grad;
    g.fillRect(0, 0, 3000, 1600);
    const blob = await new Promise(ok => c.toBlob(ok, 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  });
  const file = { name: 'screen.png', mimeType: 'image/png', buffer: Buffer.from(bigPng, 'base64') };
  await page.setInputFiles('#file-input', [file, file]);
  await page.waitForFunction(() => document.querySelectorAll('#pending .thumb').length === 2 && !document.querySelector('#pending .thumb.loading'));
  await page.click('#pending .thumb .x');
  if ((await page.$$('#pending .thumb')).length !== 1) fail('✕ не убрал миниатюру');
  await page.fill('#input', '');
  if (await page.isDisabled('#send-btn')) fail('«Отправить» неактивна при картинке без текста');
  await shot('chat-image-pending');
  await page.click('#send-btn');
  await page.waitForSelector('#send-btn:not(.hidden)', { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelectorAll('.msg.assistant:not(.streaming)').length === 3, null, { timeout: 15_000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.msg.user')].at(-1).querySelector('.imgs img')?.complete);
  const sentImg = await page.evaluate(async () => {
    const img = [...document.querySelectorAll('.msg.user')].at(-1).querySelector('.imgs img');
    const bmp = await createImageBitmap(await (await fetch(img.src)).blob());
    return { href: img.parentElement.getAttribute('href'), target: img.parentElement.target, w: bmp.width, h: bmp.height, pending: document.querySelectorAll('#pending .thumb').length };
  });
  if (!/^uploads\/[0-9a-f-]{36}\.jpg$/.test(sentImg.href) || sentImg.target !== '_blank') fail(`ссылка на картинку: ${JSON.stringify(sentImg)}`);
  if (Math.max(sentImg.w, sentImg.h) !== 2000) fail(`картинка не уменьшена до 2000 px: ${sentImg.w}×${sentImg.h}`);
  if (sentImg.pending) fail('миниатюры над полем не очистились после отправки');
  await page.evaluate(() => { const s = document.getElementById('chat-scroll'); s.scrollTop = s.scrollHeight; });
  await shot('chat-image-sent');

  await page.click('nav.tabs button[data-tab="plan"]');
  await page.waitForSelector('#projects .project.active .card-head');
  await shot('plan-projects');
  await page.click('#projects .project.active .card-head');
  await page.waitForSelector('#projects .plan .task');
  await shot('plan');
  const bar = await page.evaluate(() => {
    const head = document.querySelector('#projects .project.active .card-head');
    const [done, total] = head.querySelector('.meta').textContent.match(/выполнено (\d+) из (\d+)/).slice(1).map(Number);
    const ratio = head.querySelector('.bar > div').offsetWidth / head.querySelector('.bar').clientWidth;
    return { want: done / total, got: ratio };
  });
  if (Math.abs(bar.want - bar.got) > 0.02) fail(`полоса прогресса ${bar.got.toFixed(2)} вместо ${bar.want.toFixed(2)}`);
  if (await page.evaluate(() => /undefined|NaN/.test(document.getElementById('tab-plan').textContent))) {
    fail('во вкладке «План» есть undefined/NaN');
  }

  const target = await page.$('#projects .plan .task:not(.done) > button') ?? await page.$('#projects .plan .task > button');
  await target.click();
  await page.waitForSelector('#projects .plan .task.open .body:not(.hidden)');
  await target.evaluate(n => n.scrollIntoView({ block: 'start' }));
  await shot('plan-task-open');

  await page.click('nav.tabs button[data-tab="status"]');
  await page.waitForFunction(() => document.getElementById('status-text').textContent.startsWith('Статус'));
  await shot('status');

  await page.click('#pause-btn');
  await page.waitForSelector('#cmd-note.ok');
  await shot('status-paused');
  const sent = ntfyBodies.find(b => b.url === '/shots-cmd' && b.body === 'пауза' && b.auth === 'Bearer tk_shots');
  if (!sent) fail(`ntfy не получил «пауза» с токеном: ${JSON.stringify(ntfyBodies)}`);
} finally {
  await browser.close();
  await server.close();
  ntfy.close();
  rmSync(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\nFAIL: ${failures.length} проблем(ы)`);
  process.exit(1);
}
console.log(`\nOK: снимки в ${OUT} (план ${basename(PLAN)})`);
