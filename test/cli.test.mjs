import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pidRecord } from '../lib/pidfile.mjs';
import { requestSwitch } from '../lib/projects.mjs';

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
async function daemon(mode, { preState, since, fakePlan, config } = {}) {
  const { spawn } = await import('node:child_process');
  const n = await fakeNtfyCmd();
  const { root, cfg } = setup();
  writeFileSync(join(root, 'config.json'), JSON.stringify({ ...cfg, ntfyServer: n.url, ntfyTopic: 'tp', ntfyCommands: true, ntfyCommandToken: 'phone', ...config }));
  mkdirSync(join(root, 'state'), { recursive: true });
  if (preState) writeFileSync(join(root, 'state', 'state.json'), JSON.stringify(preState));
  if (since) writeFileSync(join(root, 'state', 'commands.since'), since + '\n');
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
