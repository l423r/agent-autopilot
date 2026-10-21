#!/usr/bin/env node
// Live check of phone commands against the real ntfy server from config.json.
// A throwaway project (2 tasks) and its own stateDir; topic <ntfyTopic>-livecheck, so the
// service and the real topic are left alone. Claude is test/fixtures/fake-claude.mjs (slow).
// The "phone" (ntfyCommandToken) publishes commands and reads notifications with poll=1.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let daemon = null;
const repo = fileURLToPath(new URL('..', import.meta.url));
const real = JSON.parse(readFileSync(process.env.AUTOPILOT_CONFIG ?? join(repo, 'config.json'), 'utf8'));
for (const k of ['ntfyServer', 'ntfyTopic', 'ntfyToken', 'ntfyCommandToken']) {
  if (!real[k]) fail(`в config.json нет ${k}`);
}
const server = real.ntfyServer.replace(/\/$/, '');
const topic = `${real.ntfyTopic}-livecheck`;
const phone = { Authorization: `Bearer ${real.ntfyCommandToken}` };

const PLAN = `## Этап 1. Проверка
### Task 1: первая
- [ ] s
### Task 2: вторая
- [ ] s
`;

const root = mkdtempSync(join(tmpdir(), 'ap-live-'));
writeFileSync(join(root, 'plan.md'), PLAN);
writeFileSync(join(root, 'progress.md'), '');
const cfg = {
  ...JSON.parse(readFileSync(join(repo, 'config.example.json'), 'utf8')),
  projectDir: root, planPath: 'plan.md', progressPath: 'progress.md',
  autopilotDir: repo, stateDir: join(root, 'state'), logDir: join(root, 'logs'),
  ntfyServer: real.ntfyServer, ntfyToken: real.ntfyToken, ntfyCommandToken: real.ntfyCommandToken,
  ntfyTopic: topic, ntfyCommands: true, notifyEachTask: true, pushAfterTask: false,
};
writeFileSync(join(root, 'config.json'), JSON.stringify(cfg));

const started = Math.floor(Date.now() / 1000);
let passed = 0;

function fail(msg) {
  console.error(`ПРОВАЛ: ${msg}`);
  if (daemon) daemon.kill('SIGTERM');
  process.exit(1);
}
function ok(msg) {
  passed++;
  console.log(`OK  ${msg}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const state = () => {
  try { return JSON.parse(readFileSync(join(root, 'state', 'state.json'), 'utf8')); } catch { return {}; }
};
const log = () => {
  try { return readFileSync(join(root, 'logs', 'autopilot.log'), 'utf8'); } catch { return ''; }
};

// Notifications of the livecheck topic since the start, read as the phone.
async function poll() {
  const res = await fetch(`${server}/${topic}/json?poll=1&since=${started}`, { headers: phone, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) fail(`poll ${topic}: HTTP ${res.status}`);
  return (await res.text()).split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(m => m.event === 'message');
}

async function waitFor(what, pred, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > end) fail(`не дождался: ${what}\n--- лог автопилота ---\n${log()}`);
    await sleep(300);
  }
}

// Waits for a notification not seen before (index >= from) that matches.
const waitMsg = (what, from, pred, timeoutMs) =>
  waitFor(what, async () => (await poll()).slice(from).find(pred), timeoutMs);

async function publishCommand(text) {
  const res = await fetch(`${server}/${topic}-cmd`, { method: 'POST', headers: phone, body: text, signal: AbortSignal.timeout(15_000) });
  if (res.status !== 200) fail(`публикация «${text}» в ${topic}-cmd: HTTP ${res.status}`);
}

console.log(`Сервер ${server}, тема ${topic}, проект ${root}`);
daemon = spawn('node', [join(repo, 'autopilot.mjs'), 'run'], {
  env: {
    ...process.env, AUTOPILOT_CONFIG: join(root, 'config.json'),
    AUTOPILOT_CLAUDE: join(repo, 'test/fixtures/fake-claude.mjs'), FAKE_MODE: 'slow', FAKE_PLAN: join(root, 'plan.md'),
  },
  stdio: 'ignore',
});
daemon.on('exit', code => { if (daemon) fail(`демон завершился (код ${code})\n${log()}`); });

try {
  // 1. Pause during an iteration: Task 1 finishes, Task 2 does not start.
  await waitFor('демон слушает команды', () => /слушаю .*-cmd/.test(log()));
  await waitFor('запуск Task 1', () => /run Task 1/.test(log()));
  let seen = (await poll()).length;
  await publishCommand('пауза');
  const r1 = await waitMsg('ответ на «пауза»', seen, m => /Пауза после текущей задачи: Task 1/.test(m.message ?? ''));
  ok(`«пауза» во время Task 1 → «${r1.message}»`);
  await waitMsg('уведомление «на паузе»', seen, m => /на паузе/.test(m.title ?? ''));
  await waitFor('status paused', () => state().status === 'paused');
  await sleep(1500);
  const plan1 = readFileSync(join(root, 'plan.md'), 'utf8');
  if (!/- \[x\] s\n### Task 2[^\n]*\n- \[ \] s/.test(plan1)) fail(`после паузы ожидалось 1/2 задачи:\n${plan1}`);
  if (/run Task 2/.test(log())) fail('Task 2 запустилась несмотря на паузу');
  ok('после Task 1 статус paused, Task 2 не запускалась');

  // 2. Status while paused.
  seen = (await poll()).length;
  await publishCommand('Статус');
  const r2 = await waitMsg('ответ на «Статус»', seen, m => /^Статус: paused/.test(m.message ?? ''));
  if (!/Прогресс: 1\/2/.test(r2.message) || !/Task 2/.test(r2.message)) fail(`ответ на статус без прогресса 1/2 и Task 2: ${r2.message}`);
  ok(`«Статус» → «${r2.message.replace(/\n/g, ' | ')}»`);

  // 3. Resume: Task 2 runs, the plan is done.
  seen = (await poll()).length;
  await publishCommand('продолжить');
  await waitMsg('ответ «Продолжаю работу»', seen, m => /Продолжаю работу/.test(m.message ?? ''));
  ok('«продолжить» → «Продолжаю работу»');
  await waitFor('status done', () => state().status === 'done');
  const done = await waitMsg('уведомление «готово»', seen, m => /готово/.test(m.title ?? ''));
  ok('Task 2 выполнена, статус done, пришло «готово»');

  // 4. Buttons: the notification carries actions; the button sent as is is accepted.
  const all = await poll();
  const taskDone = all.find(m => /Task 1 готова/.test(m.title ?? ''));
  if (!taskDone?.actions?.length) fail(`у «Task 1 готова» нет actions: ${JSON.stringify(taskDone)}`);
  if (taskDone.actions[0].label !== 'Пауза' || taskDone.actions[0].body !== 'pause') fail(`кнопка задачи не «Пауза→pause»: ${JSON.stringify(taskDone.actions)}`);
  ok(`«Task 1 готова» с кнопкой ${taskDone.actions[0].label}→${taskDone.actions[0].body}`);
  const btn = done.actions?.find(a => a.label === 'Статус');
  if (!btn) fail(`у «готово» нет кнопки «Статус»: ${JSON.stringify(done.actions)}`);
  if (btn.action !== 'http' || btn.method !== 'POST' || btn.url !== `${server}/${topic}-cmd`) fail(`кнопка не та: ${JSON.stringify(btn)}`);
  seen = all.length;
  const res = await fetch(btn.url, { method: btn.method, headers: btn.headers, body: btn.body, signal: AbortSignal.timeout(15_000) });
  if (res.status !== 200) fail(`кнопка «Статус» отвергнута сервером: HTTP ${res.status}`);
  ok(`кнопка «Статус» как есть (${btn.method} ${btn.url}, тело ${btn.body}) → HTTP 200`);
  const r4 = await waitMsg('ответ на кнопку «Статус»', seen, m => /^Статус: done/.test(m.message ?? ''));
  ok(`ответ на кнопку → «${r4.message.replace(/\n/g, ' | ')}»`);

  // 5. Restart: commands already handled are not executed again.
  const d = daemon;
  daemon = null;
  d.kill('SIGTERM');
  await new Promise(r => d.once('exit', r));
  const before = log().split('\n').filter(l => /команда с телефона/.test(l)).length;
  daemon = spawn('node', [join(repo, 'autopilot.mjs'), 'run'], {
    env: { ...process.env, AUTOPILOT_CONFIG: join(root, 'config.json'), AUTOPILOT_CLAUDE: join(repo, 'test/fixtures/fake-claude.mjs'), FAKE_MODE: 'slow', FAKE_PLAN: join(root, 'plan.md') },
    stdio: 'ignore',
  });
  daemon.on('exit', code => { if (daemon) fail(`демон после перезапуска завершился (код ${code})`); });
  await waitFor('перезапущенный демон слушает', () => log().split('\n').filter(l => /слушаю .*-cmd/.test(l)).length === 2);
  await sleep(4000);
  const after = log().split('\n').filter(l => /команда с телефона/.test(l)).length;
  if (after !== before) fail(`после перезапуска повторно обработано команд: ${after - before}`);
  ok('после перезапуска старые команды не выполнены повторно');
} finally {
  const d = daemon;
  daemon = null;
  d?.kill('SIGTERM');
}
rmSync(root, { recursive: true, force: true });
console.log(`Все проверки OK (${passed})`);
