#!/usr/bin/env node
// Visual check of the panel: starts the server with a fake planner and a fake ntfy, drives Chromium at phone size
// and saves docs/screenshots/web-<screen>.png. Fails on a console error, horizontal scrolling or script injection.
// Usage: node scripts/web-screenshots.mjs [planFile]   (default: the sigaret-counter plan)
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
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
  // Hidden last line: the suggested reply (each part is its own assistant message, so it comes whole).
  '<!-- suggest: Да, запускай -->\n',
];

const failures = [];
const fail = msg => { failures.push(msg); console.error(`✗ ${msg}`); };

const work = mkdtempSync(join(tmpdir(), 'pult-shots-'));
// Two projects: the active one on the given plan, the other with this repo's plans (finished and not).
const projectDir = join(work, 'sigaret');
mkdirSync(join(projectDir, 'plans'), { recursive: true });
copyFileSync(PLAN, join(projectDir, 'plans', basename(PLAN)));
const otherDir = join(work, 'autopilot');
mkdirSync(join(otherDir, 'plans'), { recursive: true });
copyFileSync(join(ROOT, 'docs', 'plans', '2026-10-21-web-panel.md'), join(otherDir, 'plans', '2026-10-21-web-panel.md'));
// The repo's plans all get finished; untick the last step so one stays unfinished whatever their state.
const v2 = readFileSync(join(ROOT, 'docs', 'plans', '2026-10-21-pult-v2.md'), 'utf8');
const lastTick = v2.lastIndexOf('- [x]');
writeFileSync(join(otherDir, 'plans', '2026-10-21-pult-v2.md'),
  lastTick < 0 ? v2 : `${v2.slice(0, lastTick)}- [ ]${v2.slice(lastTick + 5)}`);
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
  projectDir, planPath: join('plans', basename(PLAN)), stateDir, autopilotDir: ROOT,
  projects: [{ name: 'sigaret', projectDir, plansDir: 'plans' }, { name: 'autopilot', projectDir: otherDir, plansDir: 'plans' }],
  ntfyServer: `http://127.0.0.1:${ntfy.address().port}`, ntfyTopic: 'shots', ntfyCommandToken: 'tk_shots', ntfyCommands: true,
};
const LIMITS = {
  fiveHour: { percent: 37, resetsAt: new Date(Date.now() + 30 * 60_000).toISOString() },
  week: { percent: 81.4, resetsAt: new Date(Date.now() + 6 * 86_400_000).toISOString() },
};
const server = await startServer(cfg, {
  port: 0, claudeBin: join(ROOT, 'test', 'fixtures', 'fake-claude-stream.mjs'), limitsFetch: async () => LIMITS,
});
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

  await page.evaluate(() => {
    window.__leak = '';
    new MutationObserver(() => {
      const t = document.querySelector('.msg.streaming')?.textContent || '';
      if (/<!--|suggest/.test(t)) window.__leak = t.slice(-40);
    }).observe(document.getElementById('msgs'), { childList: true, subtree: true, characterData: true });
  });
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

  // Suggested reply: hidden line → placeholder and a one-tap button; typing hides the button.
  const leak = await page.evaluate(() => window.__leak);
  if (leak) fail(`служебная строка видна во время ответа: «${leak}»`);
  if (await page.evaluate(() => /<!--|suggest/.test(document.getElementById('msgs').textContent))) fail('служебная строка видна в чате');
  const sug = await page.evaluate(() => ({ btn: document.getElementById('suggest-btn').textContent, ph: document.getElementById('input').placeholder }));
  if (sug.btn !== '↵ Да, запускай' || sug.ph !== 'Да, запускай') fail(`подсказка: ${JSON.stringify(sug)}`);
  if (!(await page.isVisible('#suggest-btn'))) fail('кнопка подсказки не видна');
  await shot('chat-suggest');
  await page.type('#input', 'Н');
  if (await page.isVisible('#suggest-btn')) fail('кнопка подсказки не скрылась при наборе');

  // `@` opens the project picker above the field; a tap inserts `@name `, the sent message highlights it.
  await page.fill('#input', '');
  await page.type('#input', 'Что с @sig');
  await page.waitForSelector('#mentions:not(.hidden) button');
  await shot('chat-mention');
  await page.click('#mentions button');
  const typed = await page.inputValue('#input');
  if (typed !== 'Что с @sigaret ') fail(`после выбора проекта в поле «${typed}»`);
  if (await page.isVisible('#mentions')) fail('список проектов не закрылся после выбора');
  await page.type('#input', 'и a@mail.ru?');
  await page.click('#send-btn');
  await page.waitForSelector('#send-btn:not(.hidden)', { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelectorAll('.msg.assistant:not(.streaming)').length === 2, null, { timeout: 15_000 });
  const marks = await page.evaluate(() => [...document.querySelectorAll('.msg.user')].at(-1).querySelectorAll('.mention').length);
  if (marks !== 1) fail(`в сообщении подсвечено упоминаний: ${marks}, нужно 1`);
  if (await page.evaluate(() => document.body.innerText.includes('[Проекты из сообщения]'))) fail('служебный блок проектов виден на странице');

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

  // A tap on the suggestion sends it as the user's message.
  await page.fill('#input', '');
  await page.click('#suggest-btn');
  await page.waitForSelector('#send-btn:not(.hidden)', { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelectorAll('.msg.assistant:not(.streaming)').length === 4, null, { timeout: 15_000 });
  const lastUser = await page.evaluate(() => [...document.querySelectorAll('.msg.user')].at(-1).textContent);
  if (lastUser !== 'Да, запускай') fail(`по тапу отправлено «${lastUser}»`);

  await page.click('nav.tabs button[data-tab="plan"]');
  await page.waitForSelector('#projects .project.active .card-head');
  const names = await page.$$eval('#projects .project .pname', ns => ns.map(n => n.textContent));
  if (names.join() !== 'sigaret,autopilot') fail(`проекты во вкладке «План»: ${names}`);
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

  // The other project lists all its plans; «Запустить» while a task runs → switch after the task.
  await page.click('#projects .project.active .card-head');
  const other = '#projects .project:not(.active)';
  await page.click(`${other} .card-head`);
  await page.waitForSelector(`${other} .details:not(.hidden) .plan-row`);
  const plans = await page.$$eval(`${other} .plan-row`, ns => ns.map(n => n.innerText.replace(/\s+/g, ' ').trim()));
  if (plans.length !== 2 || !plans.some(p => p.includes('Запустить'))) fail(`планы второго проекта: ${JSON.stringify(plans)}`);
  // The current plan opens with its tasks; fold them so the picture shows the list of plans.
  await page.waitForSelector(`${other} .plan ul.tasks:not(.hidden) .task`);
  await page.click(`${other} .plan-toggle`);
  await page.$eval(`${other} .card-head`, n => n.scrollIntoView({ block: 'start' }));
  await shot('plan-other-project');
  await page.click(`${other} .plan-row .btn`);
  await page.waitForSelector('#switch-note.ok');
  const note = await page.$eval('#switch-note', n => n.textContent);
  if (!note.startsWith('✓ Переключится после текущей задачи: autopilot / ')) fail(`итог «Запустить»: ${note}`);
  if (!existsSync(join(stateDir, 'switch.json'))) fail('switch.json не записан');
  await page.$eval('#switch-note', n => n.scrollIntoView({ block: 'start' }));
  await shot('plan-switch');

  await page.click('#menu-btn');
  await page.click('#limits-btn');
  await page.waitForSelector('#limits .limit .bar');
  const limits = await page.$$eval('#limits .limit', ns => ns.map(n => n.innerText.replace(/\s+/g, ' ').trim()));
  const pad = n => String(n).padStart(2, '0');
  const week = new Date(LIMITS.week.resetsAt);
  const weekDate = `${pad(week.getDate())}.${pad(week.getMonth() + 1)}`;
  if (!/^5 часов 37% сброс (сегодня|\d\d\.\d\d) \d\d:\d\d$/.test(limits[0] ?? '')) fail(`лимит 5 часов: ${limits[0]}`);
  if (!new RegExp(`^Неделя 81% сброс ${weekDate.replace('.', '\\.')} \\d\\d:\\d\\d$`).test(limits[1] ?? '')) fail(`лимит неделя: ${limits[1]}`);
  if (await page.$('nav.tabs button.active')) fail('при лимитах подсвечена вкладка');
  await shot('limits');

  await page.route('**/api/limits', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"error":"Сервер лимитов ответил 401"}' }));
  await page.click('#limits-refresh');
  await page.waitForFunction(() => document.getElementById('limits').innerText.includes('Нет данных о лимитах'));
  if (!(await page.$eval('#limits', n => n.innerText)).includes('ответил 401')) fail('нет текста ошибки лимитов');
  await shot('limits-error');
  await page.unroute('**/api/limits');

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
