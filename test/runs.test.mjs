import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usageOf } from '../lib/classify.mjs';
import { appendRun, summarizeRuns } from '../lib/runs.mjs';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../autopilot.mjs', import.meta.url));
const fake = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const repo = fileURLToPath(new URL('..', import.meta.url));
const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'ap-runs-')); temps.push(d); return d; };

test('usageOf reads tokens and cost from the result JSON', () => {
  const out = 'noise\n{"type":"result","is_error":false,"total_cost_usd":0.42,"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":30,"cache_creation_input_tokens":40}}\n';
  assert.deepEqual(usageOf(out), {
    tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
    costUsd: 0.42,
  });
});

test('usageOf without JSON → nulls', () => {
  assert.deepEqual(usageOf('spawn error: ENOENT'), { tokens: null, costUsd: null });
  assert.deepEqual(usageOf('{"type":"result","is_err'), { tokens: null, costUsd: null });
});

test('summarizeRuns groups by model and skips broken lines', () => {
  const lines = [
    JSON.stringify({ model: 'haiku', result: 'ok', done: true, durationSec: 10, costUsd: 0.1, tokens: { output: 5 } }),
    JSON.stringify({ model: 'haiku', result: 'error', done: false, durationSec: 30, costUsd: null, tokens: null }),
    JSON.stringify({ model: 'sonnet', result: 'ok', done: true, durationSec: 20, costUsd: 0.5, tokens: { output: 7 } }),
    JSON.stringify({ model: null, result: 'ok', done: false, durationSec: 4, costUsd: null, tokens: null }),
    '{"model":"opus","res',
    '',
  ];
  const s = summarizeRuns(lines);
  assert.equal(s.skipped, 1);
  assert.equal(s.byModel.haiku.runs, 2);
  assert.equal(s.byModel.haiku.ok, 1);
  assert.equal(s.byModel.haiku.done, 1);
  assert.equal(s.byModel.haiku.avgDurationSec, 20);
  assert.equal(s.byModel.haiku.totalCostUsd, 0.1);
  assert.equal(s.byModel.haiku.tokensOut, 5);
  assert.equal(s.byModel.sonnet.done, 1);
  assert.equal(s.byModel['по умолчанию'].runs, 1);
});

test('appendRun writes one JSON line to runs.jsonl', () => {
  const dir = join(tempDir(), 'logs');
  appendRun(dir, { task: 'Task 1', model: null });
  appendRun(dir, { task: 'Task 2', model: 'opus' });
  const lines = readFileSync(join(dir, 'runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => l.task), ['Task 1', 'Task 2']);
});

function setup(plan, extra = {}) {
  const root = tempDir();
  writeFileSync(join(root, 'plan.md'), plan);
  writeFileSync(join(root, 'progress.md'), '');
  const cfg = {
    ...JSON.parse(readFileSync(join(repo, 'config.example.json'), 'utf8')),
    projectDir: root, planPath: 'plan.md', progressPath: 'progress.md',
    autopilotDir: repo, stateDir: join(root, 'state'), logDir: join(root, 'logs'), retryMinutes: 0.01, ...extra,
  };
  writeFileSync(join(root, 'config.json'), JSON.stringify(cfg));
  return root;
}
const exec = (root, args, env = {}) => run('node', [cli, ...args], {
  env: { ...process.env, AUTOPILOT_CONFIG: join(root, 'config.json'), AUTOPILOT_CLAUDE: fake, FAKE_PLAN: join(root, 'plan.md'), ...env },
  timeout: 30_000,
});

test('stats on an empty log → «Запусков пока нет»', async () => {
  const root = setup('### Task 1: a\n- [ ] s\n');
  const { stdout } = await exec(root, ['stats']);
  assert.match(stdout, /Запусков пока нет/);
});

test('once writes a run line, also when the run fails; stats shows it', async () => {
  const root = setup('### Task 1: a · model: haiku\n- [ ] s\n', { retryMinutes: 0 });
  await exec(root, ['once'], { AUTOPILOT_CLAUDE: join(root, 'no-such-claude') }).catch(() => {});
  await exec(root, ['once'], { FAKE_MODE: 'tick' });
  const log = join(root, 'logs', 'runs.jsonl');
  const runs = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(runs.length, 2);
  assert.equal(runs[0].task, 'Task 1');
  assert.equal(runs[0].title, 'a');
  assert.equal(runs[0].model, 'haiku');
  assert.equal(runs[0].attempt, 1);
  assert.equal(runs[0].result, 'error');
  assert.equal(runs[0].done, false);
  assert.equal(runs[0].tokens, null);
  assert.equal(runs[0].costUsd, null);
  assert.equal(runs[0].plan, 'plan.md');
  assert.equal(typeof runs[0].durationSec, 'number');
  assert.equal(runs[1].model, 'sonnet');
  assert.equal(runs[1].attempt, 2);
  assert.equal(runs[1].result, 'ok');
  assert.equal(runs[1].done, true);
  writeFileSync(log, readFileSync(log, 'utf8') + '{"broken\n');
  const { stdout } = await exec(root, ['stats']);
  assert.match(stdout, /haiku/);
  assert.match(stdout, /пропущено строк: 1/);
  const other = await exec(root, ['stats', '--plan', 'other.md']);
  assert.match(other.stdout, /Запусков пока нет/);
});
