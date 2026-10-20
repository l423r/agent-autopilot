import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
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
