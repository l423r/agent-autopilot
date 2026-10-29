import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt, runIteration, killOrphan } from '../lib/runner.mjs';
import { pidRecord } from '../lib/pidfile.mjs';

const fake = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const task = { id: 'Task 2', title: 'Second', phase: null, manual: false, done: false, lastInPhase: true };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const tempDir = prefix => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d; };

function setup() {
  const root = tempDir('ap-run-');
  const cfg = { projectDir: root, autopilotDir: root, planPath: 'plan.md', progressPath: 'progress.md' };
  return { cfg, stateDir: join(root, 'state'), logDir: join(root, 'logs') };
}

test('buildPrompt substitutes placeholders', () => {
  const p = buildPrompt('Do {{taskId}}: {{taskTitle}} from {{planPath}}, log to {{progressPath}}', task, { planPath: 'docs/plan.md', progressPath: 'docs/progress.md' });
  assert.equal(p, 'Do Task 2: Second from docs/plan.md, log to docs/progress.md');
});

test('captures output and exit code', async () => {
  const { cfg, stateDir, logDir } = setup();
  const r = await runIteration({ task, cfg, stateDir, logDir, claudeBin: fake, timeoutMs: 10_000, env: { FAKE_MODE: 'ok' } });
  assert.equal(r.exitCode, 0);
  assert.equal(r.timedOut, false);
  assert.match(r.output, /"result"/);
  assert.equal(readdirSync(logDir).filter(f => f.startsWith('iter-')).length, 1);
  assert.equal(existsSync(join(stateDir, 'child.pid')), false);
});

test('model adds --model to claude arguments', async () => {
  const { cfg, stateDir, logDir } = setup();
  const r = await runIteration({ task, cfg, stateDir, logDir, claudeBin: fake, timeoutMs: 10_000, env: { FAKE_MODE: 'args' }, model: 'haiku' });
  assert.match(r.output, /--model haiku/);
});

test('no model → no --model', async () => {
  const { cfg, stateDir, logDir } = setup();
  const r = await runIteration({ task, cfg, stateDir, logDir, claudeBin: fake, timeoutMs: 10_000, env: { FAKE_MODE: 'args' } });
  assert.match(r.output, /args: /);
  assert.doesNotMatch(r.output, /--model/);
});

test('timeout kills process', async () => {
  const { cfg, stateDir, logDir } = setup();
  const r = await runIteration({ task, cfg, stateDir, logDir, claudeBin: fake, timeoutMs: 500, env: { FAKE_MODE: 'hang' } });
  assert.equal(r.timedOut, true);
  assert.equal(existsSync(join(stateDir, 'child.pid')), false);
});

test('killOrphan kills leftover child', async () => {
  const { stateDir } = setup();
  const child = spawn(fake, [], { env: { ...process.env, FAKE_MODE: 'hang' }, stdio: 'ignore', detached: true });
  await new Promise(r => setTimeout(r, 200));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'child.pid'), pidRecord(child.pid));
  await killOrphan(stateDir);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(alive(child.pid), false);
  assert.equal(existsSync(join(stateDir, 'child.pid')), false);
});

test('killOrphan ignores a pid recorded in another boot', async () => {
  const { stateDir } = setup();
  const child = spawn(fake, [], { env: { ...process.env, FAKE_MODE: 'hang' }, stdio: 'ignore', detached: true });
  await new Promise(r => setTimeout(r, 200));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'child.pid'), `${child.pid} 00000000-0000-0000-0000-000000000000 1`);
  await killOrphan(stateDir);
  assert.equal(alive(child.pid), true);
  assert.equal(existsSync(join(stateDir, 'child.pid')), false);
  process.kill(-child.pid, 'SIGKILL');
});
