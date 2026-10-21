import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pidRecord } from '../lib/pidfile.mjs';

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
  const root = mkdtempSync(join(tmpdir(), 'ap-cli-'));
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
  const remote = mkdtempSync(join(tmpdir(), 'ap-remote-'));
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
async function daemon(mode, { preState, since } = {}) {
  const { spawn } = await import('node:child_process');
  const n = await fakeNtfyCmd();
  const { root, cfg } = setup();
  writeFileSync(join(root, 'config.json'), JSON.stringify({ ...cfg, ntfyServer: n.url, ntfyTopic: 'tp', ntfyCommands: true, ntfyCommandToken: 'phone' }));
  mkdirSync(join(root, 'state'), { recursive: true });
  if (preState) writeFileSync(join(root, 'state', 'state.json'), JSON.stringify(preState));
  if (since) writeFileSync(join(root, 'state', 'commands.since'), since + '\n');
  const child = spawn('node', [cli, 'run'], {
    env: { ...process.env, AUTOPILOT_CONFIG: join(root, 'config.json'), AUTOPILOT_CLAUDE: fake, FAKE_MODE: mode, FAKE_PLAN: join(root, 'plan.md') },
    stdio: 'ignore',
  });
  const exited = new Promise(r => child.on('exit', r));
  return {
    root, n, child,
    replies: () => n.got.filter(g => g.path === '/tp'),
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited;
      n.close();
    },
  };
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
