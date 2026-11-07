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

const fakeCodex = fileURLToPath(new URL('./fixtures/fake-codex.sh', import.meta.url));
const codexModels = { haiku: { model: 'gpt-fast', effort: 'low' }, sonnet: { model: 'gpt-main', effort: 'medium' } };

test('codex: exec --json in projectDir without approvals, model and effort from codexModels, prompt last', async () => {
  const { cfg, stateDir, logDir } = setup();
  const r = await runIteration({ task, cfg: { ...cfg, codexModels }, stateDir, logDir, executor: 'codex', codexBin: fakeCodex, timeoutMs: 10_000, prompt: '-Do Task 2', model: 'sonnet' });
  assert.equal(r.exitCode, 0);
  assert.match(r.output, new RegExp(`^args: exec --json -C ${cfg.projectDir} --dangerously-bypass-approvals-and-sandbox -m gpt-main -c model_reasoning_effort="medium"$`, 'm'));
  assert.match(r.output, /^prompt: -Do Task 2$/m);
  assert.doesNotMatch(r.output, /--permission-mode|--output-format/);
  assert.match(r.output, /"turn.completed"/);
});

test('codex: no model, or a mark missing from codexModels → codex default model, no -m', async () => {
  const { cfg, stateDir, logDir } = setup();
  for (const model of [null, 'opus']) {
    const r = await runIteration({ task, cfg: { ...cfg, codexModels }, stateDir, logDir, executor: 'codex', codexBin: fakeCodex, timeoutMs: 10_000, model });
    assert.doesNotMatch(r.output, / -m | model_reasoning_effort/);
  }
});

test('CODEX_HOME reaches the codex process only; codex gets no CLAUDE_CONFIG_DIR', async () => {
  const { cfg, stateDir, logDir } = setup();
  const saved = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.CODEX_HOME = '/daemon/codex';
  process.env.CLAUDE_CONFIG_DIR = '/daemon/claude';
  try {
    const c = await runIteration({ task, cfg, stateDir, logDir, executor: 'codex', codexBin: fakeCodex, timeoutMs: 10_000, env: { CODEX_HOME: '/acc/codex' } });
    assert.match(c.output, /^env: CODEX_HOME=\/acc\/codex CLAUDE_CONFIG_DIR=-$/m);
    const k = await runIteration({ task, cfg, stateDir, logDir, claudeBin: fake, timeoutMs: 10_000, env: { FAKE_MODE: 'env' } });
    assert.match(k.output, /^env: CODEX_HOME=-$/m);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const fakeTmp = fileURLToPath(new URL('./fixtures/fake-tmp.mjs', import.meta.url));
for (const executor of ['claude', 'codex']) {
  for (const mode of ['ok', 'error', 'signal', 'timeout']) {
    test(`${executor}: private TMPDIR is removed after ${mode}`, async () => {
      const { cfg, stateDir, logDir } = setup();
      cfg.tmpBase = join(cfg.projectDir, 'run-tmp');
      const r = await runIteration({
        task, cfg, stateDir, logDir, executor, claudeBin: fakeTmp, codexBin: fakeTmp,
        timeoutMs: mode === 'timeout' ? 1000 : 10_000,
        env: { TMPDIR: cfg.projectDir, FAKE_TMP_HANG: mode === 'timeout' ? '1' : '', FAKE_TMP_SIGNAL: mode === 'signal' ? '1' : '', FAKE_TMP_ERROR: mode === 'error' ? '1' : '' },
      });
      const { tmp, dir } = JSON.parse(r.output.split('\n')[0]);
      assert.ok(tmp.startsWith(cfg.tmpBase + '/'), tmp);
      assert.ok(dir.startsWith(tmp + '/'));
      assert.equal(existsSync(tmp), false);
      assert.equal(existsSync(join(stateDir, 'child.pid')), false);
      assert.equal(r.timedOut, mode === 'timeout');
      if (mode === 'ok' || mode === 'error') assert.equal(r.exitCode, mode === 'ok' ? 0 : 1);
      if (mode === 'timeout') {
        const { childPid } = JSON.parse(r.output.split('\n')[1]);
        // A killed grandchild can briefly remain a zombie until init reaps it.
        const { readFileSync } = await import('node:fs');
        if (alive(childPid)) assert.equal(readFileSync(`/proc/${childPid}/stat`, 'utf8').split(' ')[2], 'Z');
      }
    });
  }
}

test('spawn failure also removes private TMPDIR', async () => {
  const { cfg, stateDir, logDir } = setup();
  cfg.tmpBase = join(cfg.projectDir, 'run-tmp');
  const r = await runIteration({ task, cfg, stateDir, logDir, claudeBin: '/missing/executor', timeoutMs: 1000 });
  assert.match(r.output, /spawn error/);
  assert.deepEqual(readdirSync(cfg.tmpBase), []);
});

test('pid record failure stops the spawned process and removes its TMPDIR', async () => {
  const { cfg, stateDir, logDir } = setup();
  const { mkdirSync } = await import('node:fs');
  cfg.tmpBase = join(cfg.projectDir, 'run-tmp');
  mkdirSync(join(stateDir, 'child.pid'), { recursive: true });
  await assert.rejects(async () => runIteration({ task, cfg, stateDir, logDir, claudeBin: fake, timeoutMs: 1000 }), { code: 'EISDIR' });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(readdirSync(cfg.tmpBase), []);
});

test('TMPDIR fixture leaves no artifacts when discovered by node --test', async () => {
  const root = tempDir('ap-fixture-');
  const { execFileSync } = await import('node:child_process');
  execFileSync(fakeTmp, [], { env: { ...process.env, TMPDIR: root } });
  assert.deepEqual(readdirSync(root), []);
});

for (const executor of ['claude', 'codex']) {
  for (const mode of ['timeout', 'group signal', 'graceful group signal']) {
    test(`${executor}: ${mode} stops a stubborn descendant with closed output before returning`, async () => {
      const { cfg, stateDir, logDir } = setup();
      cfg.tmpBase = join(cfg.projectDir, 'run-tmp');
      let childPid;
      try {
        const r = await runIteration({
          task, cfg, stateDir, logDir, executor, claudeBin: fakeTmp, codexBin: fakeTmp,
          timeoutMs: 1000, env: { FAKE_TMP_HANG: '1', FAKE_TMP_STUBBORN: '1', FAKE_TMP_GROUP_SIGNAL: mode !== 'timeout' ? '1' : '', FAKE_TMP_GRACEFUL: mode === 'graceful group signal' ? '1' : '' },
        });
        childPid = JSON.parse(r.output.split('\n')[1]).childPid;
        assert.equal(r.timedOut, mode === 'timeout');
        if (mode === 'graceful group signal') assert.equal(r.exitCode, 0);
        const { readFileSync } = await import('node:fs');
        const executing = () => {
          try { return readFileSync(`/proc/${childPid}/stat`, 'utf8').split(' ')[2] !== 'Z'; }
          catch (err) { if (err.code === 'ENOENT') return false; throw err; }
        };
        // Let the kernel deliver SIGKILL; do not wait for the former 10-second unref timer.
        const deadline = Date.now() + 500;
        while (executing() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(executing(), false, 'descendant still executing after runner returned');
        assert.deepEqual(readdirSync(cfg.tmpBase), []);
      } finally {
        if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
      }
    });
  }
}
