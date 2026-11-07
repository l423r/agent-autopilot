import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, tickStep } from '../lib/plan.mjs';

const plan = [
  '# План',
  '',
  '### Task 1: Код · model: sonnet',
  '',
  '- [ ] **Step 1:** тесты',
  '',
  '### Task 2: [planner] Выкладка',
  '',
  '- [ ] **Step 1:** перезапуск',
  '',
  '### Task 3: [manual] Посмотреть видео',
  '',
  'Видео: https://example.com/v?a=1&b=2',
  '',
  '- [ ] **Step 1:** посмотреть',
  '- [ ] **Step 2:** проверить звук',
  '',
].join('\n');

const diffCount = (a, b) => {
  assert.equal(a.length, b.length);
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
};

test('tickStep ticks one step of a manual task, rest byte for byte', () => {
  const r = tickStep(plan, 'Task 3', 1);
  assert.equal(r.error, undefined);
  assert.equal(r.taskDone, false);
  assert.equal(diffCount(plan, r.markdown), 1);
  assert.match(r.markdown, /- \[x\] \*\*Step 1:\*\* посмотреть/);
  assert.match(r.markdown, /- \[ \] \*\*Step 2:\*\* проверить звук/);
  const t = parsePlan(r.markdown).tasks[2];
  assert.equal(t.checked, 1);
});

test('tickStep on the last step reports taskDone', () => {
  const once = tickStep(plan, 'Task 3', 2);
  assert.equal(once.taskDone, false);
  const twice = tickStep(once.markdown, 'Task 3', 1);
  assert.equal(twice.taskDone, true);
  assert.equal(parsePlan(twice.markdown).tasks[2].done, true);
});

test('tickStep refuses planner and auto tasks', () => {
  assert.deepEqual(tickStep(plan, 'Task 1', 1), { error: 'not-manual' });
  assert.deepEqual(tickStep(plan, 'Task 2', 1), { error: 'not-manual' });
});

test('tickStep: unknown task and step', () => {
  assert.deepEqual(tickStep(plan, 'Task 9', 1), { error: 'no-task' });
  assert.deepEqual(tickStep(plan, 'Task 3', 3), { error: 'no-step' });
  assert.deepEqual(tickStep(plan, 'Task 3', 0), { error: 'no-step' });
  assert.deepEqual(tickStep(plan, 'Task 3', 1.5), { error: 'no-step' });
});

test('tickStep: already ticked step', () => {
  const r = tickStep(plan, 'Task 3', 1);
  assert.deepEqual(tickStep(r.markdown, 'Task 3', 1), { error: 'already' });
  const upper = plan.replace('- [ ] **Step 1:** посмотреть', '- [X] **Step 1:** посмотреть');
  assert.deepEqual(tickStep(upper, 'Task 3', 1), { error: 'already' });
});

test('tickStep keeps CRLF line endings', () => {
  const crlf = plan.replace(/\n/g, '\r\n');
  const r = tickStep(crlf, 'Task 3', 2);
  assert.equal(diffCount(crlf, r.markdown), 1);
  assert.equal(r.markdown.split('\r\n').length, crlf.split('\r\n').length);
  assert.match(r.markdown, /- \[x\] \*\*Step 2:\*\* проверить звук\r\n/);
});

test('tickStep numbers nested boxes like parsePlan and skips fenced ones', () => {
  const md = [
    '### Task 4: Покупка [manual]',
    '- [ ] Step 1',
    '  - [ ] вложенный',
    '```',
    '- [ ] в коде, не шаг',
    '```',
    '* [ ] Step 3',
  ].join('\n');
  assert.equal(parsePlan(md).tasks[0].boxes, 3);
  const r = tickStep(md, 'Task 4', 2);
  assert.equal(diffCount(md, r.markdown), 1);
  assert.match(r.markdown, /^ {2}- \[x\] вложенный$/m);
  assert.match(r.markdown, /^- \[ \] в коде, не шаг$/m);
  const r3 = tickStep(md, 'Task 4', 3);
  assert.match(r3.markdown, /^\* \[x\] Step 3$/m);
  assert.match(r3.markdown, /^- \[ \] в коде, не шаг$/m);
});

test('tickStep treats [planner] with autopilot restart as manual, like parsePlan', () => {
  const md = [
    '### Task 8: [planner] Включение',
    '- [ ] **Step 1:** `systemctl restart agent-autopilot`',
  ].join('\n');
  assert.equal(parsePlan(md).tasks[0].kind, 'user');
  assert.equal(tickStep(md, 'Task 8', 1).taskDone, true);
});

test('planTitle strips implementation suffix and falls back to filename', async () => {
  const { planTitle } = await import('../lib/plan.mjs');
  assert.equal(planTitle('# Пример X — план реализации\n', 'docs/a.md'), 'Пример X');
  assert.equal(planTitle('intro\n# Первый\n# Второй', 'docs/a.md'), 'Первый');
  assert.equal(planTitle('без заголовка', 'docs/пример.md'), 'пример');
});

// CLI integration uses isolated state/tmp directories and fake executors only.
async function daemonCase(t, { status = 'idle', mode = 'ok', command = 'once', codex = false, setupFailure = false, switchPlan = false, groupSignal = false } = {}) {
  const fs = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { promisify } = await import('node:util');
  const { execFile } = await import('node:child_process');
  const root = fs.mkdtempSync(join(tmpdir(), 'ap-heartbeat-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = fileURLToPath(new URL('..', import.meta.url));
  fs.mkdirSync(join(root, 'state'));
  fs.mkdirSync(join(root, 'tmp'));
  fs.writeFileSync(join(root, 'plan.md'), '# Пример X — план реализации\n### Task 1: готово\n- [x] s\n### Task 2: работа · model: sonnet\n- [ ] s\n'.replace('Task 2: работа', status === 'waiting-user' ? 'Task 2: [manual] работа' : 'Task 2: работа'));
  fs.writeFileSync(join(root, 'state/state.json'), JSON.stringify({ status, attempts: {}, reason: 'test', nextAttemptAt: '2099-01-01T00:00:00Z' }));
  if (command === 'run' && status === 'waiting-user') fs.writeFileSync(join(root, 'state/queue.json'), JSON.stringify({ items: [] }));
  if (switchPlan) {
    fs.copyFileSync(join(root, 'plan.md'), join(root, 'other.md'));
    fs.writeFileSync(join(root, 'state/switch.json'), JSON.stringify({ projectDir: root, planPath: 'other.md', progressPath: 'progress.md' }));
  }
  const cfg = { ...JSON.parse(fs.readFileSync(join(repo, 'config.example.json'), 'utf8')), accounts: undefined, projectDir: root, planPath: 'plan.md', progressPath: 'progress.md', autopilotDir: repo,
    stateDir: join(root, 'state'), logDir: join(root, 'logs'), tmpDir: join(root, 'tmp'), tmpBase: join(root, 'runs'),
    iterationTimeoutMinutes: mode === 'hang' ? .01 : 1, retryMinutes: 1, maxAttempts: 3,
    ...(codex && { executor: 'codex', accounts: [{ name: 'main' }, { name: 'cx', kind: 'codex' }], codexModels: { sonnet: { model: 'gpt-test', effort: 'high' } } }) };
  fs.writeFileSync(join(root, 'config.json'), JSON.stringify(cfg));
  // Record every atomic state write; accelerate the clock and heartbeat timer in this process only.
  const preload = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const rename = fs.renameSync;
    fs.renameSync = (a,b) => { rename(a,b); if (b === ${JSON.stringify(join(root, 'state/state.json'))}) fs.appendFileSync(${JSON.stringify(join(root, 'history'))}, fs.readFileSync(b,'utf8').trim().replace(/\\n/g,' ')+'\\n'); ${setupFailure ? `if (b === ${JSON.stringify(join(root, 'state/state.json'))} && JSON.parse(fs.readFileSync(b,'utf8')).run) fs.mkdirSync(${JSON.stringify(join(root, 'state/child.pid'))}, {recursive:true});` : ''} };
    ${groupSignal ? `const write = fs.writeFileSync; fs.writeFileSync = (p,...args) => { write(p,...args); if (p === ${JSON.stringify(join(root, 'state/child.pid'))}) setTimeout(() => process.kill(-Number(fs.readFileSync(p,'utf8').split(' ')[0]), 'SIGTERM'), 80); };` : ''}
    syncBuiltinESMExports();
    const RealDate = Date; const epoch = RealDate.now();
    globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [epoch + (RealDate.now()-epoch)*10000])); } static now() { return epoch + (RealDate.now()-epoch)*10000; } };
    const interval = globalThis.setInterval;
    let ticks = 0;
    globalThis.setInterval = (fn,ms,...args) => interval(() => { fn(...args); ${command === 'run' ? 'if (ms === 60000 && ++ticks === 4) process.kill(process.pid, "SIGTERM");' : ''} },ms === 60000 ? ${switchPlan ? 60000 : 30} : ms);`;
  let error;
  try {
    await promisify(execFile)(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, join(repo, 'autopilot.mjs'), command], {
      timeout: 10_000, env: { ...process.env, AUTOPILOT_CONFIG: join(root, 'config.json'),
        AUTOPILOT_CLAUDE: join(repo, 'test/fixtures/fake-claude.mjs'), AUTOPILOT_CODEX: join(repo, 'test/fixtures/fake-codex.sh'), FAKE_MODE: mode },
    });
  } catch (err) { error = err; }
  const history = fs.existsSync(join(root, 'history')) ? fs.readFileSync(join(root, 'history'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const final = JSON.parse(fs.readFileSync(join(root, 'state/state.json'), 'utf8'));
  return { root, history, final, error };
}

test('each daemon cycle writes heartbeat in every status', async t => {
  for (const status of ['idle', 'running', 'sleeping', 'halted', 'waiting-user', 'paused', 'done', 'auth']) {
    const { final, error } = await daemonCase(t, { status });
    assert.equal(error, undefined);
    assert.ok(Number.isFinite(Date.parse(final.heartbeatAt)), status);
    assert.equal(final.run, null, status);
    if (!['idle', 'running'].includes(status)) assert.equal(final.status, status);
  }
});

test('waiting-user and sleeping keep heartbeating while waiting between cycles', async t => {
  for (const status of ['waiting-user', 'sleeping']) {
    const { history } = await daemonCase(t, { status, command: 'run' });
    const beats = history.filter(s => s.status === status && s.heartbeatAt);
    assert.ok(new Set(beats.map(s => s.heartbeatAt)).size >= 2, status);
  }
});

test('run describes actual executor/model and clears after success, error, timeout and setup rejection', async t => {
  for (const options of [{}, { mode: 'limit' }, { mode: 'hang' }, { setupFailure: true }, { codex: true }]) {
    const { root, history, final, error } = await daemonCase(t, options);
    if (options.setupFailure) assert.ok(error); else assert.equal(error, undefined);
    const running = history.find(s => s.status === 'running' && s.run);
    assert.ok(running, JSON.stringify(options));
    const { run } = running;
    assert.deepEqual(run, {
      project: root.split('/').at(-1), planPath: 'plan.md', planTitle: 'Пример X', taskId: 'Task 2', taskTitle: 'работа',
      done: 1, total: 2, executor: options.codex ? 'codex' : 'claude', model: options.codex ? 'gpt-test' : 'sonnet',
      attempt: 1, maxAttempts: 3, startedAt: running.updatedAt, lastOutputAt: running.updatedAt,
    });
    assert.equal(final.run, null);
    if (!options.setupFailure) assert.ok(history.some(s => s.run && s.run.lastOutputAt > run.startedAt), 'output updates lastOutputAt');
    if (options.mode === 'hang') {
      assert.ok(new Set(history.filter(s => s.run).map(s => s.heartbeatAt)).size >= 2, 'heartbeat during run');
    }
  }
});


test('plan switch keeps heartbeat present before the first timer fires', async t => {
  const { history, final, error } = await daemonCase(t, { switchPlan: true });
  assert.equal(error, undefined);
  const running = history.find(s => s.run);
  assert.equal(running.run.planPath, 'other.md');
  assert.ok(Number.isFinite(Date.parse(running.heartbeatAt)), 'heartbeat at launch after switch');
  assert.ok(Number.isFinite(Date.parse(final.heartbeatAt)), 'heartbeat after completion');
});

test('signal to executor group clears run and private TMPDIR', async t => {
  const { root, final, error } = await daemonCase(t, { mode: 'hang', groupSignal: true });
  assert.equal(error, undefined);
  assert.equal(final.run, null);
  const { readdirSync } = await import('node:fs');
  assert.deepEqual(readdirSync(`${root}/runs`), []);
});

test('planTitle does not borrow the next line after an empty heading', async () => {
  const { planTitle } = await import('../lib/plan.mjs');
  assert.equal(planTitle('#\nОбычный текст', 'docs/fallback.md'), 'fallback');
  assert.equal(planTitle('#\r\nОбычный текст', 'docs/fallback.md'), 'fallback');
});
