import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pidRecord } from '../lib/pidfile.mjs';
import { requestSwitch, planKey } from '../lib/projects.mjs';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../autopilot.mjs', import.meta.url));
const fake = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const repo = fileURLToPath(new URL('..', import.meta.url));
const PLAN = `## Этап 1. A
### Task 1: one
- [x] s
### Task 2: two
- [ ] s
## Этап 2. B
### Task 3: three
- [ ] s
`;

function setup(progress = '') {
  const root = tempDir('ap-cli-');
  writeFileSync(join(root, 'plan.md'), PLAN);
  writeFileSync(join(root, 'progress.md'), progress);
  const cfg = {
    ...JSON.parse(readFileSync(join(repo, 'config.example.json'), 'utf8')),
    accounts: undefined,
    projectDir: root, planPath: 'plan.md', progressPath: 'progress.md',
    autopilotDir: repo, stateDir: join(root, 'state'), logDir: join(root, 'logs'), retryMinutes: 0.01,
  };
  writeFileSync(join(root, 'config.json'), JSON.stringify(cfg));
  return { root, cfg };
}

const exec = (root, args, mode) => run('node', [cli, ...args], {
  env: { ...process.env, AUTOPILOT_CONFIG: join(root, 'config.json'), AUTOPILOT_CLAUDE: fake, FAKE_MODE: mode ?? 'ok', FAKE_PLAN: join(root, 'plan.md') },
  timeout: 30_000,
});
const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const tempDir = prefix => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d; };
const state = root => JSON.parse(readFileSync(join(root, 'state', 'state.json'), 'utf8'));

test('once with FAKE_MODE=limit → status sleeping', async () => {
  const { root } = setup();
  await exec(root, ['once'], 'limit');
  const s = state(root);
  assert.equal(s.status, 'sleeping');
  assert.equal(s.currentTask, 'Task 2');
  assert.ok(s.nextAttemptAt);
});

test('run stops with halted after 3 failures', async () => {
  const { root } = setup();
  await exec(root, ['run'], 'ok');
  const s = state(root);
  assert.equal(s.status, 'halted');
  assert.match(readFileSync(join(root, 'logs', 'autopilot.log'), 'utf8'), /halted/);
});

test('run completes when fake ticks boxes', async () => {
  const { root } = setup();
  await exec(root, ['run'], 'tick');
  assert.equal(state(root).status, 'done');
  assert.doesNotMatch(readFileSync(join(root, 'plan.md'), 'utf8'), /- \[ \]/);
});

test('second daemon exits immediately', async () => {
  const { root } = setup();
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'state', 'daemon.lock'), pidRecord(process.pid));
  const { stdout } = await exec(root, ['run'], 'tick');
  assert.match(stdout, /уже работает/);
  assert.match(readFileSync(join(root, 'plan.md'), 'utf8'), /- \[ \]/);
});

test('status prints progress and APK line', async () => {
  const { root } = setup('- 2026-10-20 Task 1: сделано\nAPK: https://expo.dev/x\n');
  const { stdout } = await exec(root, ['status']);
  assert.match(stdout, /1\/3/);
  assert.match(stdout, /https:\/\/expo\.dev\/x/);
});

test('status: executor codex → limits line from the sessions log; no data → понятная строка', async () => {
  const { root, cfg } = setup();
  const home = join(root, 'codexhome');
  const dir = join(home, 'sessions', '2026', '11', '06');
  mkdirSync(dir, { recursive: true });
  const at = Math.floor(Date.now() / 1000) + 3600;
  writeFileSync(join(dir, 'rollout-a.jsonl'), JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: {
    primary: { used_percent: 12.4, window_minutes: 300, resets_at: at }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: at + 1000 } } } }) + '\n');
  const withCodex = { ...cfg, executor: 'codex', accounts: [{ name: 'основная' }, { name: 'codex', kind: 'codex', codexHome: home }] };
  writeFileSync(join(root, 'config.json'), JSON.stringify(withCodex));
  assert.match((await exec(root, ['status'])).stdout, /Исполнитель: codex \(5 ч: 12 %, неделя: 40 %\)/);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ ...withCodex, accounts: [{ name: 'основная' }, { name: 'codex', kind: 'codex', codexHome: join(root, 'none') }] }));
  assert.match((await exec(root, ['status'])).stdout, /Исполнитель: codex \(нет данных о лимитах\)/);
});

test('status with an old config without projects prints the plan from planPath', async () => {
  const root = tempDir('ap-cli-');
  writeFileSync(join(root, 'plan.md'), PLAN);
  writeFileSync(join(root, 'progress.md'), '');
  const cfg = {
    projectDir: root, planPath: 'plan.md', progressPath: 'progress.md',
    autopilotDir: repo, stateDir: join(root, 'state'), logDir: join(root, 'logs'),
    retryMinutes: 15, maxAttempts: 3, iterationTimeoutMinutes: 60, limitPatterns: [], authPatterns: [],
  };
  writeFileSync(join(root, 'config.json'), JSON.stringify(cfg));
  const { stdout } = await exec(root, ['status']);
  assert.match(stdout, /Прогресс: 1\/3/);
  assert.match(stdout, /Task 2: two/);
});

test('resume clears halted state', async () => {
  const { root } = setup();
  await exec(root, ['run'], 'ok');
  assert.equal(state(root).status, 'halted');
  await exec(root, ['resume']);
  assert.equal(state(root).status, 'idle');
});

test('stale lock from a previous boot does not block the daemon', async () => {
  const { root } = setup();
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'state', 'daemon.lock'), `${process.pid} 00000000-0000-0000-0000-000000000000 1`);
  await exec(root, ['run'], 'tick');
  assert.equal(state(root).status, 'done');
});

test('daemon killed mid-iteration still counts the attempt', async () => {
  const { root } = setup();
  await exec(root, ['once'], 'killparent').catch(() => {});
  const s = state(root);
  assert.equal(s.status, 'running');
  assert.equal(s.attempts['Task 2'], 1);
});

// A project repo with a bare "origin" and one local commit that is not pushed yet.
function setupGit(extra) {
  const ctx = setup();
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  const remote = tempDir('ap-remote-');
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  git(ctx.root, 'init', '-q', '-b', 'main');
  git(ctx.root, 'config', 'user.email', 't@t');
  git(ctx.root, 'config', 'user.name', 't');
  writeFileSync(join(ctx.root, '.gitignore'), 'state/\nlogs/\nconfig.json\n');
  git(ctx.root, 'add', '-A');
  git(ctx.root, 'commit', '-q', '-m', 'init');
  git(ctx.root, 'remote', 'add', 'origin', remote);
  git(ctx.root, 'push', '-q', '-u', 'origin', 'main');
  writeFileSync(join(ctx.root, 'work.txt'), 'x');
  git(ctx.root, 'add', 'work.txt');
  git(ctx.root, 'commit', '-q', '-m', 'work');
  writeFileSync(join(ctx.root, 'config.json'), JSON.stringify({ ...ctx.cfg, ...extra }));
  return { ...ctx, remote, head: () => git(ctx.root, 'rev-parse', 'HEAD'), remoteHead: () => git(remote, 'rev-parse', 'main') };
}

test('pushAfterTask pushes the project after each finished task', async () => {
  const g = setupGit({ pushAfterTask: true });
  await exec(g.root, ['run'], 'tick');
  assert.equal(state(g.root).status, 'done');
  assert.equal(g.remoteHead(), g.head());
  assert.match(readFileSync(join(g.root, 'logs', 'autopilot.log'), 'utf8'), /push Task 2: ок/);
});

test('without pushAfterTask nothing is pushed', async () => {
  const g = setupGit({});
  await exec(g.root, ['run'], 'tick');
  assert.notEqual(g.remoteHead(), g.head());
});

test('a failed push is logged and does not stop the autopilot', async () => {
  const g = setupGit({ pushAfterTask: true });
  rmSync(g.remote, { recursive: true, force: true });
  await exec(g.root, ['run'], 'tick');
  assert.equal(state(g.root).status, 'done');
  assert.match(readFileSync(join(g.root, 'logs', 'autopilot.log'), 'utf8'), /push Task 2: не удался/);
});

test('an unfinished task is not pushed', async () => {
  const g = setupGit({ pushAfterTask: true });
  await exec(g.root, ['once'], 'ok');
  assert.notEqual(g.remoteHead(), g.head());
});

test('ntfy: a notification per finished task and one when the plan is done', async () => {
  const { fakeNtfy } = await import('./notify.test.mjs');
  const n = await fakeNtfy();
  const { root, cfg } = setup();
  writeFileSync(join(root, 'config.json'), JSON.stringify({ ...cfg, ntfyServer: n.url, ntfyTopic: 'tp', notifyEachTask: true }));
  await exec(root, ['run'], 'tick');
  n.close();
  const titles = n.got.map(g => g.params.title);
  assert.equal(titles.filter(t => /Task 2|Task 3/.test(t)).length, 2, titles.join(' | '));
  assert.equal(titles.filter(t => /готово/i.test(t)).length, 1, titles.join(' | '));
  assert.match(n.got.at(-1).body, /3\/3/);
});

test('ntfy: a restart of an already stopped autopilot does not notify again', async () => {
  const { fakeNtfy } = await import('./notify.test.mjs');
  const n = await fakeNtfy();
  const { root, cfg } = setup();
  writeFileSync(join(root, 'config.json'), JSON.stringify({ ...cfg, ntfyServer: n.url, ntfyTopic: 'tp' }));
  await exec(root, ['run'], 'tick');
  const before = n.got.length;
  await exec(root, ['run'], 'tick');
  n.close();
  assert.equal(before, 1);
  assert.equal(n.got.length, 1);
});

test('ntfy: halting after repeated failures notifies once', async () => {
  const { fakeNtfy } = await import('./notify.test.mjs');
  const n = await fakeNtfy();
  const { root, cfg } = setup();
  writeFileSync(join(root, 'config.json'), JSON.stringify({ ...cfg, ntfyServer: n.url, ntfyTopic: 'tp' }));
  await exec(root, ['run'], 'ok');
  n.close();
  assert.deepEqual(n.got.map(g => g.params.title).filter(t => /застрял/i.test(t)).length, 1);
});

test('ntfy: hitting a usage limit notifies with the resume time', async () => {
  const { fakeNtfy } = await import('./notify.test.mjs');
  const n = await fakeNtfy();
  const { root, cfg } = setup();
  writeFileSync(join(root, 'config.json'), JSON.stringify({ ...cfg, ntfyServer: n.url, ntfyTopic: 'tp' }));
  await exec(root, ['once'], 'limit');
  n.close();
  assert.equal(n.got.length, 1);
  assert.match(n.got[0].params.title, /лимит/i);
  assert.match(n.got[0].body, /\d{2}:\d{2}/);
});

// --- Phone commands (ntfyCommands) ---

// A local ntfy: records publications to <topic> and serves <topic>-cmd as a JSON stream.
// since=<id> → messages after that id; since=<seconds> → messages not older than that.
async function fakeNtfyCmd(topic = 'tp') {
  const { createServer } = await import('node:http');
  const got = [];
  const cmds = [];
  const streams = new Set();
  const subs = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === `/${topic}-cmd/json`) {
      const since = url.searchParams.get('since');
      subs.push(since);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ id: `open${subs.length}`, time: Math.floor(Date.now() / 1000), event: 'open' }) + '\n');
      const at = cmds.findIndex(c => c.id === since);
      const old = at >= 0 ? cmds.slice(at + 1) : cmds.filter(c => /^\d+$/.test(since) && c.time >= Number(since));
      for (const c of old) res.write(JSON.stringify(c) + '\n');
      streams.add(res);
      res.on('close', () => streams.delete(res));
      return;
    }
    let body = '';
    req.on('data', d => (body += d)).on('end', () => {
      got.push({ path: url.pathname, params: Object.fromEntries(url.searchParams), body, at: Date.now() });
      res.end('{}');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    got, cmds, subs,
    // A command as the phone would publish it; pushed to every open stream.
    publish(message, id = `c${cmds.length + 1}`, time = Math.floor(Date.now() / 1000)) {
      const c = { id, time, event: 'message', topic: `${topic}-cmd`, message };
      cmds.push(c);
      for (const s of streams) s.write(JSON.stringify(c) + '\n');
    },
    close() { for (const s of streams) s.destroy(); server.close(); },
  };
}

const waitFor = async (cond, ms = 15_000) => {
  const end = Date.now() + ms;
  for (;;) {
    let ok = false;
    try { ok = cond(); } catch { /* state.json not written yet */ }
    if (ok) return;
    if (Date.now() > end) throw new Error(`timeout waiting for ${cond}`);
    await new Promise(r => setTimeout(r, 50));
  }
};

// A daemon with ntfyCommands on, running as a separate process; stop() sends SIGTERM.
async function daemon(mode, { preState, since, fakePlan, config, prepare } = {}) {
  const { spawn } = await import('node:child_process');
  const n = await fakeNtfyCmd();
  const { root, cfg } = setup();
  writeFileSync(join(root, 'config.json'), JSON.stringify({ ...cfg, ntfyServer: n.url, ntfyTopic: 'tp', ntfyCommands: true, ntfyCommandToken: 'phone', ...config }));
  mkdirSync(join(root, 'state'), { recursive: true });
  if (preState) writeFileSync(join(root, 'state', 'state.json'), JSON.stringify(preState));
  if (since) writeFileSync(join(root, 'state', 'commands.since'), since + '\n');
  prepare?.(root);
  const d = {
    root, n,
    replies: () => n.got.filter(g => g.path === '/tp'),
    // A crash (SIGKILL, no graceful shutdown) without closing the fake ntfy, then a fresh
    // daemon on the same project and state.
    async restart() {
      await kill('SIGKILL');
      start();
    },
    async stop() {
      await kill();
      n.close();
    },
  };
  let exited;
  const start = () => {
    d.child = spawn('node', [cli, 'run'], {
      env: { ...process.env, AUTOPILOT_CONFIG: join(root, 'config.json'), AUTOPILOT_CLAUDE: fake, FAKE_MODE: mode, FAKE_PLAN: fakePlan ?? join(root, 'plan.md') },
      stdio: 'ignore',
    });
    exited = new Promise(r => d.child.on('exit', r));
  };
  const kill = async (signal = 'SIGTERM') => {
    if (d.child.exitCode === null && d.child.signalCode === null) d.child.kill(signal);
    await exited;
  };
  start();
  return d;
}
const planText = root => readFileSync(join(root, 'plan.md'), 'utf8');
const halted = { status: 'halted', currentTask: 'Task 2', attempts: { 'Task 2': 3 }, nextAttemptAt: null, reason: 'Task 2 не удалась 3 раз подряд' };

test('commands: status during an iteration is answered before it ends, state.json untouched', async () => {
  const d = await daemon('slow');
  try {
    await waitFor(() => d.n.subs.length > 0 && state(d.root).status === 'running');
    const before = readFileSync(join(d.root, 'state', 'state.json'), 'utf8');
    d.n.publish('статус');
    await waitFor(() => d.replies().some(r => /Статус: running/.test(r.body)), 1500);
    assert.equal(readFileSync(join(d.root, 'state', 'state.json'), 'utf8'), before);
    assert.match(planText(d.root), /### Task 2: two\n- \[ \]/);
  } finally {
    await d.stop();
  }
});

test('commands: pause during an iteration lets it finish, then pauses before the next task', async () => {
  const d = await daemon('slow');
  try {
    await waitFor(() => d.n.subs.length > 0 && state(d.root).status === 'running');
    d.n.publish('пауза');
    await waitFor(() => d.replies().some(r => /после текущей задачи/i.test(r.body)), 1500);
    await waitFor(() => state(d.root).status === 'paused');
    assert.match(planText(d.root), /### Task 2: two\n- \[x\]/);
    await new Promise(r => setTimeout(r, 2500));
    assert.equal(state(d.root).status, 'paused');
    assert.match(planText(d.root), /### Task 3: three\n- \[ \]/);
    assert.equal(d.child.exitCode, null, 'daemon keeps waiting for commands');
  } finally {
    await d.stop();
  }
});

test('commands: a halted autopilot stays up and resume runs the task again', async () => {
  const d = await daemon('tick', { preState: halted });
  try {
    await waitFor(() => d.n.subs.length > 0);
    await new Promise(r => setTimeout(r, 1000));
    assert.equal(d.child.exitCode, null, 'daemon must not exit while halted');
    assert.equal(state(d.root).status, 'halted');
    d.n.publish('продолжить');
    await waitFor(() => state(d.root).status === 'done');
    assert.doesNotMatch(planText(d.root), /- \[ \]/);
  } finally {
    await d.stop();
  }
});

test('commands: resume while sleeping after a limit runs without waiting for nextAttemptAt', async () => {
  const later = new Date(Date.now() + 3_600_000).toISOString();
  const d = await daemon('tick', { preState: { status: 'sleeping', currentTask: 'Task 2', attempts: { 'Task 2': 1 }, nextAttemptAt: later, reason: 'Лимит исчерпан' } });
  try {
    await waitFor(() => d.n.subs.length > 0);
    await new Promise(r => setTimeout(r, 500));
    assert.equal(state(d.root).status, 'sleeping');
    d.n.publish('go');
    await waitFor(() => state(d.root).status === 'done');
  } finally {
    await d.stop();
  }
});

test('commands: a restart does not replay a command already handled', async () => {
  const n0 = Math.floor(Date.now() / 1000) - 60;
  const d = await daemon('tick', { preState: halted, since: 'c1' });
  d.n.publish('продолжить', 'c1', n0);
  try {
    await waitFor(() => d.n.subs.length > 0);
    assert.equal(d.n.subs[0], 'c1');
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(state(d.root).status, 'halted');
    assert.equal(d.replies().length, 0);
    assert.match(planText(d.root), /- \[ \]/);
  } finally {
    await d.stop();
  }
});

test('commands: CLI resume wakes a daemon waiting in a stopped state', async () => {
  const d = await daemon('tick', { preState: halted });
  try {
    await waitFor(() => d.n.subs.length > 0);
    await new Promise(r => setTimeout(r, 500));
    assert.equal(state(d.root).status, 'halted');
    await exec(d.root, ['resume']);
    await waitFor(() => state(d.root).status === 'done', 8000);
    assert.doesNotMatch(planText(d.root), /- \[ \]/);
  } finally {
    await d.stop();
  }
});

test('commands: resume during an iteration cancels an earlier pause', async () => {
  const d = await daemon('slow');
  try {
    await waitFor(() => d.n.subs.length > 0 && state(d.root).status === 'running');
    d.n.publish('пауза');
    await waitFor(() => d.replies().some(r => /после текущей задачи/i.test(r.body)), 1500);
    d.n.publish('продолжить');
    await waitFor(() => d.replies().some(r => /Пауза отменена/.test(r.body)), 1500);
    await waitFor(() => state(d.root).status === 'done');
    assert.doesNotMatch(planText(d.root), /- \[ \]/);
  } finally {
    await d.stop();
  }
});

test('commands: a pause acknowledged during an iteration survives a daemon restart', async () => {
  const d = await daemon('slow');
  try {
    await waitFor(() => d.n.subs.length > 0 && state(d.root).status === 'running');
    d.n.publish('пауза');
    await waitFor(() => d.replies().some(r => /после текущей задачи/i.test(r.body)), 1500);
    await d.restart();
    await waitFor(() => state(d.root).status === 'paused', 5000);
    await new Promise(r => setTimeout(r, 2500));
    assert.equal(state(d.root).status, 'paused');
    assert.match(planText(d.root), /### Task 3: three\n- \[ \]/);
  } finally {
    await d.stop();
  }
});

// --- Switching plans (active.json, switch.json) ---

const PLAN_B = `## Этап 1. B
### Task 1: b-one
- [ ] s
### Task 2: b-two
- [ ] s
`;
const planB = root => readFileSync(join(root, 'plan2.md'), 'utf8');
const toB = root => {
  writeFileSync(join(root, 'plan2.md'), PLAN_B);
  return { projectDir: root, planPath: 'plan2.md', progressPath: 'plan2.progress.md' };
};
const active = root => JSON.parse(readFileSync(join(root, 'state', 'active.json'), 'utf8'));

test('switch: status читает active.json', async () => {
  const { root } = setup();
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'state', 'active.json'), JSON.stringify(toB(root)));
  const { stdout } = await exec(root, ['status']);
  assert.match(stdout, /Прогресс: 0\/2/);
  assert.match(stdout, /Task 1: b-one/);
});

test('switch: между задачами — текущая задача A доходит до конца, дальше план B', async () => {
  const d = await daemon('slow', { fakePlan: '' });
  try {
    await waitFor(() => d.n.subs.length > 0 && state(d.root).status === 'running');
    requestSwitch(join(d.root, 'state'), toB(d.root));
    await waitFor(() => /### Task 2: b-two\n- \[x\]/.test(planB(d.root)), 20_000);
    assert.match(planText(d.root), /### Task 2: two\n- \[x\]/);
    assert.match(planText(d.root), /### Task 3: three\n- \[ \]/);
    assert.equal(active(d.root).planPath, 'plan2.md');
    await waitFor(() => state(d.root).status === 'done');
    assert.match(readFileSync(join(d.root, 'logs', 'autopilot.log'), 'utf8'), /Переключено/);
  } finally {
    await d.stop();
  }
});

test('switch: «пауза» после запроса переключения — план B выбран, но автопилот на паузе', async () => {
  const d = await daemon('slow', { fakePlan: '' });
  try {
    await waitFor(() => d.n.subs.length > 0 && state(d.root).status === 'running');
    requestSwitch(join(d.root, 'state'), toB(d.root));
    await new Promise(r => setTimeout(r, 50));
    d.n.publish('пауза');
    await waitFor(() => d.replies().some(r => /после текущей задачи/i.test(r.body)), 1500);
    await waitFor(() => existsSync(join(d.root, 'state', 'active.json')), 20_000);
    await new Promise(r => setTimeout(r, 2500));
    assert.equal(state(d.root).status, 'paused');
    assert.equal(active(d.root).planPath, 'plan2.md');
    assert.doesNotMatch(planB(d.root), /- \[x\]/);
    assert.match(planText(d.root), /### Task 2: two\n- \[x\]/);
  } finally {
    await d.stop();
  }
});

test('switch: запрос на несуществующий план не роняет демон и не меняет active.json', async () => {
  const d = await daemon('tick', { fakePlan: '', preState: { status: 'done', currentTask: null, attempts: {}, nextAttemptAt: null, reason: 'План выполнен' } });
  try {
    await waitFor(() => d.n.subs.length > 0);
    requestSwitch(join(d.root, 'state'), { projectDir: d.root, planPath: 'typo.md' });
    await waitFor(() => d.replies().some(r => /typo\.md/.test(r.body)), 2500);
    await new Promise(r => setTimeout(r, 500));
    assert.equal(d.child.exitCode, null, 'демон работает');
    assert.ok(!existsSync(join(d.root, 'state', 'active.json')));
    assert.ok(!existsSync(join(d.root, 'state', 'switch.json')));
    assert.equal(state(d.root).status, 'done');
  } finally {
    await d.stop();
  }
});

test('switch: запись projects без projectDir не роняет демон при переключении', async () => {
  const d = await daemon('tick', {
    fakePlan: '',
    preState: { status: 'done', currentTask: null, attempts: {}, nextAttemptAt: null, reason: 'План выполнен' },
    config: { projects: [{ name: 'broken', plansDir: '.' }, { name: 'proj' }] },
  });
  try {
    await waitFor(() => d.n.subs.length > 0);
    requestSwitch(join(d.root, 'state'), toB(d.root));
    await waitFor(() => d.replies().some(r => /Переключено/.test(r.body)) || d.child.exitCode !== null, 2500);
    assert.equal(d.child.exitCode, null, 'демон работает');
    assert.equal(active(d.root).planPath, 'plan2.md');
  } finally {
    await d.stop();
  }
});

test('switch: из остановленного состояния демон сразу начинает план B', async () => {
  const d = await daemon('tick', { fakePlan: '', preState: { status: 'done', currentTask: null, attempts: {}, nextAttemptAt: null, reason: 'План выполнен' } });
  try {
    await waitFor(() => d.n.subs.length > 0);
    await new Promise(r => setTimeout(r, 500));
    assert.equal(state(d.root).status, 'done');
    requestSwitch(join(d.root, 'state'), toB(d.root));
    await waitFor(() => /### Task 1: b-one\n- \[x\]/.test(planB(d.root)), 2500);
    assert.match(planText(d.root), /### Task 2: two\n- \[ \]/);
    assert.ok(d.replies().some(r => /Переключено: .+ \/ plan2\.md/.test(r.body)), d.replies().map(r => r.body).join(' | '));
  } finally {
    await d.stop();
  }
});

test('model: restart after a counted attempt runs the next step up and logs it', async () => {
  const { root } = setup();
  writeFileSync(join(root, 'plan.md'), PLAN.replace('### Task 2: two', '### Task 2: two · model: haiku'));
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'state', 'state.json'), JSON.stringify({ status: 'running', currentTask: 'Task 2', attempts: { 'Task 2': 1 }, nextAttemptAt: null, reason: null, updatedAt: null }));
  await exec(root, ['once'], 'args');
  const log = readFileSync(join(root, 'logs', 'autopilot.log'), 'utf8');
  assert.match(log, /run Task 2 \(sonnet, попытка 2\): two\n/);
  const s = state(root);
  assert.equal(s.attempts['Task 2'], 2);
  const iter = readdirSync(join(root, 'logs')).find(f => f.startsWith('iter-'));
  assert.match(readFileSync(join(root, 'logs', iter), 'utf8'), /--model sonnet/);
});

test('model: unmarked task without defaultModel logs as before', async () => {
  const { root } = setup();
  await exec(root, ['once'], 'args');
  assert.match(readFileSync(join(root, 'logs', 'autopilot.log'), 'utf8'), /run Task 2: two\n/);
});

test('model: invalid defaultModel stops the autopilot from starting', async () => {
  const { root, cfg } = setup();
  writeFileSync(join(root, 'config.json'), JSON.stringify({ ...cfg, defaultModel: 'gpt' }));
  await assert.rejects(exec(root, ['once'], 'tick'), err => /defaultModel: допустимо haiku, sonnet, opus/.test(err.stderr));
  assert.match(readFileSync(join(root, 'plan.md'), 'utf8'), /- \[ \]/);
});

test('task models end to end: once ×3 with fake-claude.sh → run log, runs.jsonl, stats', async () => {
  const fakeSh = fileURLToPath(new URL('./fixtures/fake-claude.sh', import.meta.url));
  const root = tempDir('ap-models-');
  writeFileSync(join(root, 'plan.md'), `## Этап 1. Модели
### Task 1: Данные · model: haiku
- [ ] s
### Task 2: Логика | model: Sonnet
- [ ] s
### Task 3: Без пометки
- [ ] s
`);
  writeFileSync(join(root, 'progress.md'), '');
  const cfg = {
    ...JSON.parse(readFileSync(join(repo, 'config.example.json'), 'utf8')),
    projects: undefined, accounts: undefined, projectDir: root, planPath: 'plan.md', progressPath: 'progress.md',
    autopilotDir: repo, stateDir: join(root, 'state'), logDir: join(root, 'logs'),
  };
  writeFileSync(join(root, 'config.json'), JSON.stringify(cfg));
  const env = { ...process.env, AUTOPILOT_CONFIG: join(root, 'config.json'), AUTOPILOT_CLAUDE: fakeSh, FAKE_PLAN: join(root, 'plan.md') };
  for (let i = 0; i < 3; i++) await run('node', [cli, 'once'], { env, timeout: 30_000 });

  const log = readFileSync(join(root, 'logs', 'autopilot.log'), 'utf8');
  assert.match(log, /run Task 1 \(haiku, попытка 1\): Данные\n/);
  assert.match(log, /run Task 2 \(sonnet, попытка 1\): Логика\n/);
  assert.match(log, /run Task 3: Без пометки\n/);
  assert.doesNotMatch(readFileSync(join(root, 'plan.md'), 'utf8'), /- \[ \]/);

  const runs = readFileSync(join(root, 'logs', 'runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(runs.map(r => [r.task, r.model, r.attempt, r.result, r.done]), [
    ['Task 1', 'haiku', 1, 'ok', true], ['Task 2', 'sonnet', 1, 'ok', true], ['Task 3', null, 1, 'ok', true],
  ]);
  assert.equal(runs[0].costUsd, 0.42);
  assert.equal(runs[0].tokens.output, 20);

  const iterLogs = readdirSync(join(root, 'logs')).filter(f => f.startsWith('iter-')).sort()
    .map(f => readFileSync(join(root, 'logs', f), 'utf8'));
  assert.match(iterLogs.find(t => t.includes('Task 1')), /--model haiku/);
  assert.doesNotMatch(iterLogs.find(t => t.includes('Task 3')), /--model/);

  const { stdout } = await run('node', [cli, 'stats'], { env, timeout: 30_000 });
  assert.match(stdout, /haiku/);
  assert.match(stdout, /sonnet/);
  assert.match(stdout, /по умолчанию/);
  assert.doesNotMatch(stdout, /пропущено строк/);
});

function setupPlanner(planText) {
  const { root, cfg } = setup('- 2026-10-31 Task 2: НЕ СДЕЛАНО — НУЖЕН ЧЕЛОВЕК: старая запись\n');
  writeFileSync(join(root, 'plan.md'), planText);
  const fakeSh = fileURLToPath(new URL('./fixtures/fake-claude.sh', import.meta.url));
  const env = mode => ({
    ...process.env, AUTOPILOT_CONFIG: join(root, 'config.json'), AUTOPILOT_CLAUDE: fakeSh, FAKE_MODE: mode,
    FAKE_PLAN: join(root, 'plan.md'), FAKE_PROGRESS: join(root, 'progress.md'), FAKE_PROMPT_OUT: join(root, 'prompt.txt'),
  });
  return { root, cfg, go: (args, mode) => run('node', [cli, ...args], { env: env(mode), timeout: 30_000 }) };
}

test('planner: [planner] task runs with the planner role and rules, opus by default', async () => {
  const { root, go } = setupPlanner(PLAN.replace('### Task 2: two', '### Task 2: [planner] Выкладка'));
  await go(['once'], 'tick');
  const prompt = readFileSync(join(root, 'prompt.txt'), 'utf8');
  assert.match(prompt, /Ты — планировщик проектов на этом сервере/);
  assert.match(prompt, /ТОЛЬКО шаги `Task 2: Выкладка`/);
  assert.match(prompt, /откат/);
  assert.match(prompt, /НУЖЕН ЧЕЛОВЕК/);
  assert.match(prompt, /progress\.md/);
  assert.doesNotMatch(prompt, /\{\{/);
  assert.match(readFileSync(join(root, 'logs', 'autopilot.log'), 'utf8'), /run Task 2 \(opus, попытка 1\): Выкладка\n/);
  assert.match(readFileSync(join(root, 'plan.md'), 'utf8'), /### Task 2: \[planner\] Выкладка\n- \[x\]/);
});

test('planner: an ordinary task keeps the usual prompt', async () => {
  const { root, go } = setupPlanner(PLAN);
  await go(['once'], 'tick');
  const prompt = readFileSync(join(root, 'prompt.txt'), 'utf8');
  assert.doesNotMatch(prompt, /планировщик/);
  assert.match(prompt, /Выполни ТОЛЬКО `Task 2: two`/);
});

test('planner: «НУЖЕН ЧЕЛОВЕК» without ticks → failed attempts, then halted with the reason from the log', async () => {
  const { root, go } = setupPlanner(PLAN.replace('### Task 2: two', '### Task 2: [planner] Выкладка'));
  await go(['run'], 'need-human');
  const s = state(root);
  assert.equal(s.status, 'halted');
  assert.match(s.reason, /Task 2 не удалась 3 раз подряд: НУЖЕН ЧЕЛОВЕК: нет доступа к серверу/);
  assert.match(readFileSync(join(root, 'plan.md'), 'utf8'), /### Task 2: \[planner\] Выкладка\n- \[ \]/);
  assert.equal((readFileSync(join(root, 'logs', 'autopilot.log'), 'utf8').match(/run Task 2 \(opus/g) ?? []).length, 3);
});

// --- Plan queue in the daemon (<stateDir>/queue.json) ---

const QA = `## Этап 1. A
### Task 1: a-one
- [ ] s
### Task 2: [manual] a-hand
- [ ] s
### Task 3: a-three
- [ ] s
`;
const QB = `## Этап 1. B
### Task 1: b-one
- [ ] s
### Task 2: b-two
- [ ] s
`;
const QC = `## Этап 1. C
### Task 1: c-one
- [x] s
`;
const QWAIT = `## Этап 1. W
### Task 1: [manual] w-hand
- [ ] s
`;
const qItem = (root, planPath) => ({ projectDir: root, planPath, progressPath: planPath.replace(/\.md$/, '.progress.md'), addedAt: '2026-11-01T00:00:00.000Z' });
const queueOf = root => JSON.parse(readFileSync(join(root, 'state', 'queue.json'), 'utf8'));
// Plans by file name, the queue in that order, plan.md active.
const queueSetup = (plans, queue) => root => {
  for (const [name, text] of Object.entries(plans)) writeFileSync(join(root, name), text);
  writeFileSync(join(root, 'state', 'queue.json'), JSON.stringify(queue.map(p => qItem(root, p))));
  writeFileSync(join(root, 'state', 'active.json'), JSON.stringify({ projectDir: root, planPath: 'plan.md', progressPath: 'progress.md' }));
};

test('queue: A до [manual] → B, C убран, галочка в A → A после текущей задачи B → done', async () => {
  const d = await daemon('slow', {
    fakePlan: '', config: { queueRecheckSeconds: 0.3 },
    prepare: queueSetup({ 'plan.md': QA, 'b.md': QB, 'c.md': QC }, ['plan.md', 'b.md', 'c.md']),
  });
  const text = name => readFileSync(join(d.root, name), 'utf8');
  try {
    await waitFor(() => active(d.root).planPath === 'b.md' && state(d.root).status === 'running', 15_000);
    assert.match(text('plan.md'), /### Task 1: a-one\n- \[x\]/);
    assert.ok(!queueOf(d.root).some(x => x.planPath === 'c.md'), 'завершённый C убран из очереди');
    assert.equal(queueOf(d.root)[0].waitingUser.task, 'Task 2');
    // The user ticks their task in A while B's task runs.
    writeFileSync(join(d.root, 'plan.md'), text('plan.md').replace('### Task 2: [manual] a-hand\n- [ ]', '### Task 2: [manual] a-hand\n- [x]'));
    await waitFor(() => /### Task 3: a-three\n- \[x\]/.test(text('plan.md')), 20_000);
    assert.match(text('b.md'), /### Task 1: b-one\n- \[x\]/);
    assert.match(text('b.md'), /### Task 2: b-two\n- \[ \]/);
    await waitFor(() => state(d.root).status === 'done', 20_000);
    assert.doesNotMatch(text('b.md'), /- \[ \]/);
    assert.deepEqual(queueOf(d.root), []);
    const got = d.replies().map(r => `${r.params.title} | ${r.body}`);
    assert.equal(got.filter(t => /Ждёт вас/.test(t) && /plan\.md — Task 2: a-hand/.test(t)).length, 1, got.join('\n'));
    assert.equal(got.filter(t => /План выполнен: .*c\.md/.test(t)).length, 1, got.join('\n'));
    assert.ok(got.some(t => /Переключено на .*b\.md \(тот ждёт вас\)/.test(t)), got.join('\n'));
    assert.match(readFileSync(join(d.root, 'logs', 'autopilot.log'), 'utf8'), /План выполнен/);
  } finally {
    await d.stop();
  }
});

test('queue: два плана ждут, третий завершён → waiting-user с обоими, без переключений, «Ждёт вас» по разу', async () => {
  const d = await daemon('tick', {
    fakePlan: '', config: { queueRecheckSeconds: 0.2 },
    prepare: queueSetup({ 'plan.md': QWAIT, 'w2.md': QWAIT, 'c.md': QC }, ['plan.md', 'w2.md', 'c.md']),
  });
  try {
    await waitFor(() => state(d.root).status === 'waiting-user', 10_000);
    await new Promise(r => setTimeout(r, 1500));
    const s = state(d.root);
    assert.equal(s.status, 'waiting-user');
    assert.match(s.reason, /plan\.md/);
    assert.match(s.reason, /w2\.md/);
    assert.doesNotMatch(readFileSync(join(d.root, 'logs', 'autopilot.log'), 'utf8'), /Переключено/);
    const got = d.replies().map(r => `${r.params.title} | ${r.body}`);
    assert.equal(got.filter(t => /Ждёт вас/.test(t)).length, 2, got.join('\n'));
    assert.deepEqual(queueOf(d.root).map(x => x.planPath), ['plan.md', 'w2.md']);
  } finally {
    await d.stop();
  }
});

test('queue: switch.json во время работы ставит план первым в очередь', async () => {
  const d = await daemon('slow', {
    fakePlan: '',
    prepare: queueSetup({ 'b.md': QB }, ['plan.md', 'b.md']),
  });
  try {
    await waitFor(() => d.n.subs.length > 0 && state(d.root).status === 'running');
    requestSwitch(join(d.root, 'state'), { projectDir: d.root, planPath: 'b.md', progressPath: 'b.progress.md' });
    await waitFor(() => active(d.root).planPath === 'b.md', 15_000);
    assert.deepEqual(queueOf(d.root).map(x => x.planPath), ['b.md', 'plan.md']);
  } finally {
    await d.stop();
  }
});

test('queue: пропавший план пропускается с уведомлением, битый queue.json — работа без очереди', async () => {
  const { fakeNtfy } = await import('./notify.test.mjs');
  const n = await fakeNtfy();
  const { root, cfg } = setup();
  writeFileSync(join(root, 'config.json'), JSON.stringify({ ...cfg, ntfyServer: n.url, ntfyTopic: 'tp' }));
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'state', 'queue.json'), JSON.stringify([qItem(root, 'gone.md'), qItem(root, 'plan.md')]));
  await exec(root, ['run'], 'tick');
  assert.equal(state(root).status, 'done');
  assert.ok(!queueOf(root).some(x => x.planPath === 'gone.md'));
  assert.ok(n.got.some(g => /gone\.md/.test(g.body)), n.got.map(g => g.body).join(' | '));

  const b = setup();
  mkdirSync(join(b.root, 'state'), { recursive: true });
  writeFileSync(join(b.root, 'state', 'queue.json'), '{ broken');
  await exec(b.root, ['run'], 'tick');
  n.close();
  assert.equal(state(b.root).status, 'done');
  assert.match(readFileSync(join(b.root, 'logs', 'autopilot.log'), 'utf8'), /queue\.json/);
});

// --- queue review fixes ---

test('queue: current plan deleted, the other plan waits for the user → waiting-user, no crash', async () => {
  const { root } = setup();
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'w.md'), QWAIT);
  rmSync(join(root, 'plan.md'));
  writeFileSync(join(root, 'state', 'queue.json'), JSON.stringify([qItem(root, 'plan.md'), qItem(root, 'w.md')]));
  await exec(root, ['once'], 'tick');
  const s = state(root);
  assert.equal(s.status, 'waiting-user');
  assert.match(s.reason, /w\.md/);
});

test('queue: an edit to queue.json while a notification is being sent is kept', async () => {
  const { createServer } = await import('node:http');
  const { root, cfg } = setup();
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'c.md'), QC);
  writeFileSync(join(root, 'x.md'), QB);
  writeFileSync(join(root, 'state', 'queue.json'), JSON.stringify([qItem(root, 'c.md'), qItem(root, 'plan.md')]));
  // «План выполнен» is answered late; meanwhile the panel adds x.md to the queue.
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', d => (body += d)).on('end', () => {
      if (!/План выполнен/.test(body)) return res.end("{}");
      const q = JSON.parse(readFileSync(join(root, 'state', 'queue.json'), 'utf8'));
      writeFileSync(join(root, 'state', 'queue.json'), JSON.stringify([...q, qItem(root, 'x.md')]));
      setTimeout(() => res.end('{}'), 300);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ ...cfg, ntfyServer: `http://127.0.0.1:${server.address().port}`, ntfyTopic: 'tp' }));
  try {
    await exec(root, ['once'], 'tick');
  } finally {
    server.close();
  }
  assert.deepEqual(queueOf(root).map(x => x.planPath), ['plan.md', 'x.md']);
});

test('queue: the active plan missing from the queue goes to its end, not first', async () => {
  const { root } = setup();
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'b.md'), QB);
  writeFileSync(join(root, 'state', 'queue.json'), JSON.stringify([qItem(root, 'b.md')]));
  await run('node', [cli, 'once'], {
    cwd: root, timeout: 30_000,
    env: { ...process.env, AUTOPILOT_CONFIG: join(root, 'config.json'), AUTOPILOT_CLAUDE: fake, FAKE_MODE: 'tick', FAKE_PLAN: '' },
  });
  assert.deepEqual(queueOf(root).map(x => x.planPath), ['b.md', 'plan.md']);
  assert.match(readFileSync(join(root, 'b.md'), 'utf8'), /### Task 1: b-one\n- \[x\]/);
  assert.equal(readFileSync(join(root, 'plan.md'), 'utf8'), PLAN);
});

// --- a ticked manual task in the current plan (waiting-user) ---

const tickTask = (root, name, title) => {
  const file = join(root, name);
  writeFileSync(file, readFileSync(file, 'utf8').replace(`${title}\n- [ ]`, `${title}\n- [x]`));
};
const logOf = root => readFileSync(join(root, 'logs', 'autopilot.log'), 'utf8');

test('waiting-user: a tick of the manual task in the current plan continues it without resume', async () => {
  const d = await daemon('tick', {
    config: { queueRecheckSeconds: 0.3 },
    prepare: root => writeFileSync(join(root, 'plan.md'), QA),
  });
  try {
    await waitFor(() => state(d.root).status === 'waiting-user', 10_000);
    await new Promise(r => setTimeout(r, 500));
    tickTask(d.root, 'plan.md', '### Task 2: [manual] a-hand');
    await waitFor(() => state(d.root).status === 'done', 5000);
    assert.match(planText(d.root), /### Task 3: a-three\n- \[x\]/);
    assert.match(logOf(d.root), /Ручная задача отмечена: Task 2/);
    assert.doesNotMatch(logOf(d.root), /resume/);
  } finally {
    await d.stop();
  }
});

test('waiting-user: the next task is [manual] too → waiting-user for it, «ждёт вас» once per task, no loop', async () => {
  const d = await daemon('tick', {
    config: { queueRecheckSeconds: 0.2 },
    prepare: root => writeFileSync(join(root, 'plan.md'), QA.replace('### Task 3: a-three', '### Task 3: [manual] a-hand2')),
  });
  try {
    await waitFor(() => state(d.root).status === 'waiting-user', 10_000);
    await new Promise(r => setTimeout(r, 500));
    tickTask(d.root, 'plan.md', '### Task 2: [manual] a-hand');
    await waitFor(() => /a-hand2/.test(state(d.root).reason), 5000);
    await new Promise(r => setTimeout(r, 1500));
    const s = state(d.root);
    assert.equal(s.status, 'waiting-user');
    assert.match(s.reason, /a-hand2/);
    assert.equal((logOf(d.root).match(/Ручная задача отмечена/g) ?? []).length, 1, logOf(d.root));
    const waits = d.replies().filter(r => /ждёт вас/i.test(r.params.title ?? ''));
    assert.equal(waits.filter(r => /a-hand\b(?!2)/.test(r.body)).length, 1, waits.map(r => r.body).join(' | '));
    assert.equal(waits.filter(r => /a-hand2/.test(r.body)).length, 1, waits.map(r => r.body).join(' | '));
  } finally {
    await d.stop();
  }
});

test('waiting-user: the tick finishes the current plan → «План выполнен» and the next plan of the queue, no resume', async () => {
  const d = await daemon('tick', {
    fakePlan: '', config: { queueRecheckSeconds: 0.3 },
    prepare: root => writeFileSync(join(root, 'plan.md'), QA.replace('### Task 2: [manual] a-hand\n- [ ] s\n### Task 3: a-three\n- [ ] s\n', '### Task 2: [manual] a-hand\n- [ ] s\n')),
  });
  try {
    await waitFor(() => state(d.root).status === 'waiting-user', 10_000);
    await new Promise(r => setTimeout(r, 500));
    // The queue appears while the daemon already waits (as on 2026-11-01), then the user ticks.
    writeFileSync(join(d.root, 'b.md'), QB);
    writeFileSync(join(d.root, 'state', 'queue.json'), JSON.stringify([qItem(d.root, 'plan.md'), qItem(d.root, 'b.md')]));
    tickTask(d.root, 'plan.md', '### Task 2: [manual] a-hand');
    await waitFor(() => state(d.root).status === 'done', 10_000);
    assert.equal(active(d.root).planPath, 'b.md');
    assert.doesNotMatch(readFileSync(join(d.root, 'b.md'), 'utf8'), /- \[ \]/);
    assert.match(logOf(d.root), /План выполнен: .*plan\.md/);
    assert.doesNotMatch(logOf(d.root), /resume/);
  } finally {
    await d.stop();
  }
});

for (const preState of [
  { status: 'paused', currentTask: 'Task 1', attempts: {}, nextAttemptAt: null, reason: 'Пауза по команде с телефона' },
  { status: 'halted', currentTask: 'Task 3', attempts: { 'Task 3': 3 }, nextAttemptAt: null, reason: 'Task 3 не удалась 3 раз подряд' },
]) {
  test(`waiting-user only: ${preState.status} with a runnable next task stays put`, async () => {
    const d = await daemon('tick', {
      preState, config: { queueRecheckSeconds: 0.2 },
      prepare: root => writeFileSync(join(root, 'plan.md'), QA.replace(/- \[ \] s\n### Task 2/, '- [x] s\n### Task 2').replace('a-hand\n- [ ]', 'a-hand\n- [x]')),
    });
    try {
      await waitFor(() => d.n.subs.length > 0);
      await new Promise(r => setTimeout(r, 1500));
      assert.equal(state(d.root).status, preState.status);
      assert.match(planText(d.root), /### Task 3: a-three\n- \[ \]/);
    } finally {
      await d.stop();
    }
  });
}

// 2026-11-04T11:34:21Z: the queue moved to a plan that had halted on Task 5 earlier, and the
// daemon halted at once on its old counter {"Task 5": 3}.
const haltedCounters = (root, planPath) => JSON.stringify({
  status: 'idle', currentTask: null, attempts: {}, nextAttemptAt: null, reason: null, updatedAt: null,
  attemptsByPlan: { [planKey({ projectDir: root, planPath })]: { 'Task 1': 3 } },
});

test('queue switch: a plan that had halted gets its task run again (attempt 1), not halted', async () => {
  const d = await daemon('slow', {
    fakePlan: '', config: { queueRecheckSeconds: 0.3 },
    prepare: root => {
      queueSetup({ 'plan.md': QA.replace('a-one\n- [ ]', 'a-one\n- [x]'), 'b.md': QB }, ['plan.md', 'b.md'])(root);
      writeFileSync(join(root, 'state', 'state.json'), haltedCounters(root, 'b.md'));
    },
  });
  try {
    await waitFor(() => active(d.root).planPath === 'b.md' && ['running', 'halted'].includes(state(d.root).status), 15_000);
    const s = state(d.root);
    assert.equal(s.status, 'running', s.reason);
    assert.equal(s.currentTask, 'Task 1');
    assert.equal(s.attempts['Task 1'], 1);
  } finally {
    await d.stop();
  }
});

test('switch.json: a plan that had halted gets its task run again (attempt 1), not halted', async () => {
  const d = await daemon('slow', {
    fakePlan: '',
    preState: { status: 'done', currentTask: null, attempts: {}, nextAttemptAt: null, reason: 'План выполнен' },
    prepare: root => writeFileSync(join(root, 'state', 'state.json'), haltedCounters(root, 'plan2.md').replace('"idle"', '"done"')),
  });
  try {
    await waitFor(() => d.n.subs.length > 0);
    requestSwitch(join(d.root, 'state'), toB(d.root));
    await waitFor(() => existsSync(join(d.root, 'state', 'active.json')) && ['running', 'halted'].includes(state(d.root).status), 15_000);
    const s = state(d.root);
    assert.equal(s.status, 'running', s.reason);
    assert.equal(s.currentTask, 'Task 1');
    assert.equal(s.attempts['Task 1'], 1);
  } finally {
    await d.stop();
  }
});

test('plan warnings go to the log once', async () => {
  const { root } = setup();
  writeFileSync(join(root, 'plan.md'), PLAN.replace('### Task 2: two\n- [ ] s', '### Task 2: [planner] Выкладка\n- [ ] s: `systemctl restart agent-autopilot`'));
  // Task 2 turns [manual]: run stops on it after several steps in one daemon.
  await exec(root, ['run'], 'tick');
  const log = readFileSync(join(root, 'logs', 'autopilot.log'), 'utf8');
  assert.equal((log.match(/Task 2: \[planner\] с рестартом agent-autopilot/g) ?? []).length, 1, log);
});

// --- queue commands ---
const CLI_WAITING_PLAN = `### Task 1: one
- [x] s
### Task 2: [manual] Купить домен
- [ ] s
### Task 3: three
- [ ] s
`;

function cliQueueSetup() {
  const { root } = setup();
  writeFileSync(join(root, 'waiting.md'), CLI_WAITING_PLAN);
  return root;
}
const cliQueueFile = root => join(root, 'state', 'queue.json');
const cliReadQueue = root => JSON.parse(readFileSync(cliQueueFile(root), 'utf8'));

test('queue add with a missing plan fails and writes nothing', async () => {
  const root = cliQueueSetup();
  await assert.rejects(exec(root, ['queue', 'add', root, 'nope.md']), err => {
    assert.notEqual(err.code, 0);
    assert.match(err.stderr + err.stdout, /нет плана/);
    return true;
  });
  assert.equal(existsSync(cliQueueFile(root)), false);
});

test('queue add appends plans and keeps duplicates out', async () => {
  const root = cliQueueSetup();
  await exec(root, ['queue', 'add', root, 'plan.md']);
  await exec(root, ['queue', 'add', root, 'waiting.md']);
  await exec(root, ['queue', 'add', root, 'plan.md']);
  const items = cliReadQueue(root);
  assert.deepEqual(items.map(i => i.planPath), ['plan.md', 'waiting.md']);
  assert.equal(items[1].progressPath, 'waiting.progress.md');
});

test('queue list shows numbers, plan, progress and the task it waits for', async () => {
  const root = cliQueueSetup();
  await exec(root, ['queue', 'add', root, 'plan.md']);
  await exec(root, ['queue', 'add', root, 'waiting.md']);
  const { stdout } = await exec(root, ['queue', 'list']);
  const lines = stdout.trim().split('\n');
  assert.match(lines[0], /^1\. .*plan\.md.*1\/3/);
  assert.doesNotMatch(lines[0], /ждёт вас/);
  assert.match(lines[1], /^2\. .*waiting\.md.*1\/3.*ждёт вас: Task 2/);
});

test('queue list on an empty queue says so', async () => {
  const root = cliQueueSetup();
  const { stdout } = await exec(root, ['queue', 'list']);
  assert.match(stdout, /пуста/);
});

test('queue up and remove work by number', async () => {
  const root = cliQueueSetup();
  await exec(root, ['queue', 'add', root, 'plan.md']);
  await exec(root, ['queue', 'add', root, 'waiting.md']);
  await exec(root, ['queue', 'up', '2']);
  assert.deepEqual(cliReadQueue(root).map(i => i.planPath), ['waiting.md', 'plan.md']);
  await exec(root, ['queue', 'remove', '1']);
  assert.deepEqual(cliReadQueue(root).map(i => i.planPath), ['plan.md']);
  await assert.rejects(exec(root, ['queue', 'remove', '5']), err => /нет записи 5/.test(err.stderr + err.stdout));
  await assert.rejects(exec(root, ['queue', 'up', 'x']), err => /номер/.test(err.stderr + err.stdout));
});

test('status shows the queue and what waits for you', async () => {
  const root = cliQueueSetup();
  await exec(root, ['queue', 'add', root, 'plan.md']);
  await exec(root, ['queue', 'add', root, 'waiting.md']);
  const { stdout } = await exec(root, ['status']);
  assert.match(stdout, /Очередь:\n1\. .*plan\.md.*\n2\. .*waiting\.md/);
  assert.match(stdout, /Ждёт вас:\n.*waiting\.md — Task 2: Купить домен/);
});

test('status without a queue has no queue blocks', async () => {
  const { root } = setup();
  const { stdout } = await exec(root, ['status']);
  assert.doesNotMatch(stdout, /Очередь|Ждёт вас/);
});

// --- Accounts: a limit on the primary moves the task to the spare (fake-claude.sh, FAKE_MODE=account) ---

const fakeSh = fileURLToPath(new URL('./fixtures/fake-claude.sh', import.meta.url));
function setupAccounts({ accounts = true, preState } = {}) {
  const { root, cfg } = setup();
  const alt = tempDir('ap-alt-');
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    ...cfg, projects: undefined, retryMinutes: 15,
    ...(accounts && { accounts: [{ name: 'основная' }, { name: 'запасная', configDir: alt }] }),
  }));
  if (preState) {
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, 'state', 'state.json'), JSON.stringify(preState));
  }
  const accountLog = join(root, 'accounts.log');
  const execA = (args, mode) => run('node', [cli, ...args], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: '', AUTOPILOT_CONFIG: join(root, 'config.json'), AUTOPILOT_CLAUDE: fakeSh, FAKE_MODE: mode, FAKE_PLAN: join(root, 'plan.md'), FAKE_ACCOUNT_LOG: accountLog },
    timeout: 30_000,
  });
  const runsOf = () => readFileSync(join(root, 'logs', 'runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const accountRuns = () => readFileSync(accountLog, 'utf8').trim().split('\n');
  return { root, alt, execA, runsOf, accountRuns, log: () => readFileSync(join(root, 'logs', 'autopilot.log'), 'utf8') };
}

test('accounts: a limit on the primary → the same task on the spare in the same run, no sleeping, attempt 1', async () => {
  const a = setupAccounts();
  await a.execA(['run'], 'account');
  const s = state(a.root);
  assert.equal(s.status, 'done');
  assert.equal(s.account, 'запасная');
  assert.ok(s.accountLimits['основная']);
  assert.deepEqual(a.accountRuns(), ['Task 2 -', `Task 2 ${a.alt}`, `Task 3 ${a.alt}`]);
  assert.deepEqual(a.runsOf().map(r => [r.task, r.result, r.attempt]), [['Task 2', 'limit', 1], ['Task 2', 'ok', 1], ['Task 3', 'ok', 1]]);
  const log = a.log();
  assert.match(log, /Лимит «основная» до .+, продолжаю на «запасная»/);
  assert.equal(log.match(/продолжаю на «запасная»/g).length, 1);
  assert.doesNotMatch(log, /sleeping/);
});

test('accounts: the primary reset has passed → the next task runs on the primary, «Вернулся» logged once', async () => {
  const a = setupAccounts({ preState: { status: 'idle', currentTask: null, attempts: {}, account: 'запасная', accountLimits: { 'основная': new Date(Date.now() - 60_000).toISOString() } } });
  await a.execA(['once'], 'tick');
  await a.execA(['once'], 'tick');
  assert.deepEqual(a.accountRuns(), ['Task 2 -', 'Task 3 -']);
  assert.equal(state(a.root).account, 'основная');
  assert.equal(a.log().match(/Вернулся на «основная»/g).length, 1);
});

test('accounts: a limit on both → one sleeping until the earliest reset, no switch loop', async () => {
  const a = setupAccounts();
  await a.execA(['once'], 'limit');
  assert.equal(state(a.root).status, 'idle');
  await a.execA(['once'], 'limit');
  const s = state(a.root);
  assert.equal(s.status, 'sleeping');
  assert.equal(s.nextAttemptAt, [s.accountLimits['основная'], s.accountLimits['запасная']].sort()[0]);
  const { stdout } = await a.execA(['once'], 'limit');
  assert.match(stdout, /Следующая попытка/);
  assert.deepEqual(a.accountRuns(), ['Task 2 -', `Task 2 ${a.alt}`]);
  assert.equal(s.attempts['Task 2'], undefined);
  assert.equal(a.log().match(/продолжаю на/g).length, 1);
});

test('accounts: idle with every account limited (after «продолжить») → state saved as sleeping until the earliest reset', async () => {
  const soon = new Date(Date.now() + 3_600_000).toISOString();
  const later = new Date(Date.now() + 7_200_000).toISOString();
  const a = setupAccounts({ preState: { status: 'idle', currentTask: null, attempts: {}, nextAttemptAt: null, reason: null, account: 'запасная', accountLimits: { 'основная': later, 'запасная': soon } } });
  await a.execA(['once'], 'limit');
  const s = state(a.root);
  assert.equal(s.status, 'sleeping');
  assert.equal(s.nextAttemptAt, soon);
  assert.equal(s.reason, 'Лимит исчерпан');
  assert.equal(existsSync(join(a.root, 'accounts.log')), false);
});

test('accounts: without accounts a limit sleeps and state.json has no account fields (old state.json reads)', async () => {
  const a = setupAccounts({ accounts: false, preState: { status: 'idle', currentTask: null, attempts: {}, nextAttemptAt: null, reason: null } });
  await a.execA(['once'], 'account');
  const s = state(a.root);
  assert.equal(s.status, 'sleeping');
  for (const k of ['account', 'accountLimits', 'accountAuth']) assert.equal(k in s, false);
  assert.deepEqual(a.accountRuns(), ['Task 2 -']);
  const { stdout } = await a.execA(['status']);
  assert.doesNotMatch(stdout, /Учётка/);
});

test('accounts: status prints the account and its active limits; resume keeps a limit not yet reset', async () => {
  const until = new Date(Date.now() + 3_600_000).toISOString();
  const a = setupAccounts({ preState: { status: 'halted', currentTask: 'Task 2', attempts: { 'Task 2': 3 }, account: 'запасная', accountAuth: ['запасная'], accountLimits: { 'основная': until } } });
  const { stdout } = await a.execA(['status']);
  assert.match(stdout, /^Учётка: запасная$/m);
  assert.match(stdout, /^Лимит: основная до .+$/m);
  await a.execA(['resume']);
  const s = state(a.root);
  assert.deepEqual(s.accountLimits, { 'основная': until });
  assert.equal('accountAuth' in s, false);
});

test('promptTemplate: ordinary task on codex gets prompt-codex.md, planner and claude keep theirs', async () => {
  const { promptTemplate } = await import('../lib/prompt.mjs');
  const ordinary = { id: 'Task 2', title: 'two' };
  const codex = promptTemplate(ordinary, 'codex');
  assert.match(codex, /Выполни ТОЛЬКО `\{\{taskId\}\}: \{\{taskTitle\}\}`/);
  assert.match(codex, /сначала напиши тест, запусти его и убедись, что он падает/);
  assert.match(codex, /свежий ревьюер/);
  assert.doesNotMatch(codex, /superpowers|субагент|Skill|ToolSearch/);
  assert.match(codex, /- \[x\]/);
  assert.match(codex, /НЕ СДЕЛАНО/);
  assert.match(codex, /не пушь/);
  assert.equal(promptTemplate(ordinary, 'claude'), readFileSync(join(repo, 'prompt.md'), 'utf8'));
  assert.equal(promptTemplate(ordinary), readFileSync(join(repo, 'prompt.md'), 'utf8'));
  const planner = promptTemplate({ id: 'Task 1', title: 'p', kind: 'planner' }, 'codex');
  assert.match(planner, /Ты — планировщик проектов на этом сервере/);
  assert.doesNotMatch(planner, /сначала напиши тест/);
});

// --- Codex executes ordinary tasks, Claude [planner] ones and the fallback (fake-codex.sh + fake-claude.sh) ---

const fakeCodexSh = fileURLToPath(new URL('./fixtures/fake-codex.sh', import.meta.url));
function setupCodex(planText, { ntfy } = {}) {
  const { root, cfg } = setup();
  writeFileSync(join(root, 'plan.md'), planText);
  const codexHome = tempDir('ap-codex-');
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    ...cfg, projects: undefined, retryMinutes: 15, executor: 'codex',
    accounts: [{ name: 'основная' }, { name: 'codex', kind: 'codex', codexHome }],
    ...(ntfy && { ntfyServer: ntfy.url, ntfyTopic: 'tp' }),
  }));
  const accountLog = join(root, 'accounts.log');
  const go = (args, codexMode = 'ok') => run('node', [cli, ...args], {
    env: {
      ...process.env, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', AUTOPILOT_CONFIG: join(root, 'config.json'),
      AUTOPILOT_CLAUDE: fakeSh, AUTOPILOT_CODEX: fakeCodexSh, FAKE_MODE: 'tick', FAKE_CODEX_MODE: codexMode,
      FAKE_PLAN: join(root, 'plan.md'), FAKE_ACCOUNT_LOG: accountLog,
    },
    timeout: 30_000,
  });
  const runsOf = () => readFileSync(join(root, 'logs', 'runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const accountRuns = () => readFileSync(accountLog, 'utf8').trim().split('\n');
  return { root, codexHome, go, runsOf, accountRuns, log: () => readFileSync(join(root, 'logs', 'autopilot.log'), 'utf8') };
}
const CODEX_PLAN = `## Этап 1. A
### Task 1: first
- [ ] s
### Task 2: [planner] Выкладка
- [ ] s
### Task 3: third · model: sonnet
- [ ] s
`;

test('codex: ordinary, [planner], ordinary → codex, claude, codex; log, runs.jsonl and stats name the executor', async () => {
  const c = setupCodex(CODEX_PLAN);
  await c.go(['run']);
  assert.equal(state(c.root).status, 'done');
  assert.deepEqual(c.accountRuns(), ['Task 1 codex', 'Task 2 -', 'Task 3 codex']);
  const log = c.log();
  assert.match(log, /run Task 1 \(codex, попытка 1\): first\n/);
  assert.match(log, /run Task 2 \(claude\/opus, попытка 1\): Выкладка\n/);
  assert.match(log, /run Task 3 \(codex\/sonnet, попытка 1\): third\n/);
  assert.doesNotMatch(log, /Вернулся|продолжаю на|задачу делает/);
  assert.deepEqual(c.runsOf().map(r => [r.task, r.executor, r.model, r.result]), [
    ['Task 1', 'codex', null, 'ok'], ['Task 2', 'claude', 'opus', 'ok'], ['Task 3', 'codex', 'sonnet', 'ok'],
  ]);
  assert.equal(c.runsOf()[0].tokens.output, 300);
  const iter = readdirSync(join(c.root, 'logs')).filter(f => f.startsWith('iter-')).sort().map(f => readFileSync(join(c.root, 'logs', f), 'utf8'));
  assert.match(iter[0], /^args: exec --json/m);
  assert.match(iter[0], /свежий ревьюер/);
  assert.match(iter[0], new RegExp(`CODEX_HOME=${c.codexHome} CLAUDE_CONFIG_DIR=-`));
  const { stdout } = await c.go(['stats']);
  assert.match(stdout, /^codex\/по умолчанию \| 1 \| 1 /m);
  assert.match(stdout, /^claude\/opus \| 1 \| 1 /m);
  assert.match(stdout, /^codex\/sonnet \| 1 \| 1 /m);
});

test('codex: a limit on the 1st task → the same task on Claude at once, attempt 1, one notification; reset passed → next task back on codex', async () => {
  const { fakeNtfy } = await import('./notify.test.mjs');
  const n = await fakeNtfy();
  const c = setupCodex(`## Этап 1. A
### Task 1: first
- [ ] s
### Task 2: second
- [ ] s
`, { ntfy: n });
  await c.go(['once'], 'limit-no-time');
  let s = state(c.root);
  assert.equal(s.status, 'idle');
  assert.equal(s.account, 'основная');
  assert.ok(new Date(s.accountLimits.codex) > new Date());
  assert.equal(s.attempts['Task 1'], undefined);
  await c.go(['once'], 'limit-no-time');
  assert.deepEqual(c.accountRuns(), ['Task 1 codex', 'Task 1 -']);
  assert.deepEqual(c.runsOf().map(r => [r.task, r.executor, r.result, r.attempt]), [['Task 1', 'codex', 'limit', 1], ['Task 1', 'claude', 'ok', 1]]);
  const switches = n.got.filter(g => /Codex/.test(g.body));
  assert.equal(switches.length, 1, n.got.map(g => g.body).join(' | '));
  assert.match(switches[0].body, /^Лимит Codex до .+, задачу делает Claude$/);

  s = state(c.root);
  writeFileSync(join(c.root, 'state', 'state.json'), JSON.stringify({ ...s, accountLimits: { codex: new Date(Date.now() - 60_000).toISOString() } }));
  await c.go(['once']);
  n.close();
  assert.deepEqual(c.accountRuns(), ['Task 1 codex', 'Task 1 -', 'Task 2 codex']);
  assert.doesNotMatch(readFileSync(join(c.root, 'plan.md'), 'utf8'), /- \[ \]/);
  assert.equal(state(c.root).taskAccount, 'codex');
  assert.equal(c.log().match(/Вернулся на Codex/g).length, 1);
  assert.equal(n.got.filter(g => /Вернулся на Codex/.test(g.body)).length, 1);
});

test('codex: not logged in → the task goes on on Claude, the autopilot does not stop with auth', async () => {
  const c = setupCodex(`## Этап 1. A
### Task 1: first
- [ ] s
`);
  await c.go(['run'], 'auth');
  const s = state(c.root);
  assert.equal(s.status, 'done');
  assert.deepEqual(s.accountAuth, ['codex']);
  assert.deepEqual(c.accountRuns(), ['Task 1 codex', 'Task 1 -']);
  assert.match(c.log(), /Codex не авторизован, задачу делает Claude/);
});

test('codex: a crash without JSON is an ordinary error with the output tail in the log', async () => {
  const c = setupCodex(`## Этап 1. A
### Task 1: first
- [ ] s
`);
  await c.go(['once'], 'crash');
  const s = state(c.root);
  assert.equal(s.status, 'sleeping');
  assert.equal(s.attempts['Task 1'], 1);
  assert.match(c.log(), /Task 1 → error.*panicked at exec/);
});

test('status CLI starts with now title/details for waiting-user, sleeping, halted and legacy state', async () => {
  const { root, cfg } = setup();
  mkdirSync(cfg.stateDir, { recursive: true });
  writeFileSync(join(root, 'plan.md'), '# Понятный план — план реализации\n### Task 2: [manual] Проверить\n- [ ] s\n');
  const project = root.split('/').at(-1);
  for (const [status, extra, expected] of [
    ['waiting-user', {}, `Ничего не делает: все планы в очереди ждут тебя (1)\n${project} — «Понятный план», Task 2: Проверить\n`],
    ['sleeping', { nextAttemptAt: '2099-01-01T13:05:00Z' }, 'Ждёт лимит до 1 янв., 13:05, дальше продолжит сам\n'],
    ['halted', { currentTask: 'Task 2', reason: 'ошибка' }, 'Остановился: ошибка\nЗадача Task 2 в «Понятный план»\n'],
    ['running', { heartbeatAt: undefined }, 'Автопилот не отвечает с —\nСлужба остановлена или зависла. Напиши планировщику «проверь автопилот».\n'],
  ]) {
    writeFileSync(join(cfg.stateDir, 'state.json'), JSON.stringify({ status, heartbeatAt: new Date().toISOString(), ...extra }));
    const { stdout } = await exec(root, ['status']);
    assert.ok(stdout.startsWith(expected), stdout);
    assert.match(stdout, /Статус:/);
    assert.match(stdout, /Прогресс:/);
  }
});
