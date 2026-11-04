import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePlan } from '../lib/plan.mjs';
import { decide, applyResult, resume, initialState, markRunning } from '../lib/decide.mjs';

const baseCfg = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
const cfg = { ...baseCfg };
const now = new Date('2026-10-20T12:00:00Z');
const later = new Date('2026-10-20T15:00:00Z');

const plan = parsePlan(`## Этап 1. A
### Task 1: one
- [x] s
### Task 2: two
- [ ] s
## Этап 2. B
### Task 3: three
- [ ] s`);
const planTask2Done = parsePlan(`## Этап 1. A
### Task 1: one
- [x] s
### Task 2: two
- [x] s
## Этап 2. B
### Task 3: three
- [ ] s`);
const task2 = plan.tasks[1];

test('fresh state runs next task', () => {
  const d = decide(initialState(), plan, now, cfg);
  assert.equal(d.action, 'run');
  assert.equal(d.task.id, 'Task 2');
});

test('limit sleeps until resetAt and does not count attempt', () => {
  const s = applyResult(initialState(), task2, { kind: 'limit', resetAt: later }, plan, now, cfg);
  assert.equal(s.status, 'sleeping');
  assert.equal(s.nextAttemptAt, later.toISOString());
  assert.equal(s.attempts['Task 2'], undefined);
  assert.deepEqual(decide(s, plan, now, cfg), { action: 'sleep', until: later });
  assert.equal(decide(s, plan, new Date(later.getTime() + 1000), cfg).action, 'run');
});

test('limit without resetAt sleeps retryMinutes', () => {
  const s = applyResult(initialState(), task2, { kind: 'limit' }, plan, now, cfg);
  assert.equal(s.nextAttemptAt, new Date(now.getTime() + 15 * 60_000).toISOString());
});

test('third failure halts', () => {
  let s = initialState();
  for (let i = 0; i < 3; i++) s = applyResult(s, task2, { kind: 'error' }, plan, now, cfg);
  assert.equal(s.attempts['Task 2'], 3);
  const d = decide(s, plan, now, cfg);
  assert.equal(d.action, 'stop');
  assert.equal(d.status, 'halted');
  assert.match(d.reason, /Task 2/);
});

test('ok without ticked boxes counts as failure', () => {
  const s = applyResult(initialState(), task2, { kind: 'ok' }, plan, now, cfg);
  assert.equal(s.attempts['Task 2'], 1);
  assert.equal(s.status, 'sleeping');
});

test('failure waits retryMinutes before the next attempt', () => {
  const s = applyResult(initialState(), task2, { kind: 'error' }, plan, now, cfg);
  assert.equal(s.status, 'sleeping');
  assert.equal(s.nextAttemptAt, new Date(now.getTime() + 15 * 60_000).toISOString());
  assert.equal(decide(s, plan, now, cfg).action, 'sleep');
});

test('crash-time bump: state saved as running already holds the attempt', () => {
  const running = markRunning(initialState(), task2, now);
  assert.equal(running.status, 'running');
  assert.equal(running.attempts['Task 2'], 1);
});

test('markRunning saves the model of the run', () => {
  assert.equal(markRunning(initialState(), task2, now, 'sonnet').currentModel, 'sonnet');
  assert.equal(markRunning(initialState(), task2, now).currentModel, null);
});

test('done task resets attempts', () => {
  const s = applyResult({ ...initialState(), attempts: { 'Task 2': 2 } }, task2, { kind: 'ok' }, planTask2Done, now, cfg);
  assert.deepEqual(s.attempts, {});
  assert.equal(s.status, 'idle');
});

test('auth stops with auth status', () => {
  const s = applyResult(initialState(), task2, { kind: 'auth' }, plan, now, cfg);
  assert.equal(s.status, 'auth');
  assert.equal(decide(s, plan, now, cfg).status, 'auth');
});

test('manual task stops with waiting-user', () => {
  const p = parsePlan('### Task 1: EAS [manual]\n- [ ] s');
  const d = decide(initialState(), p, now, cfg);
  assert.equal(d.action, 'stop');
  assert.equal(d.status, 'waiting-user');
  assert.match(d.reason, /EAS/);
});

test('pauseAfterPhase pauses after last task of phase', () => {
  const s = applyResult(initialState(), task2, { kind: 'ok' }, planTask2Done, now, { ...cfg, pauseAfterPhase: true });
  assert.equal(s.status, 'paused');
  assert.equal(decide(s, planTask2Done, now, cfg).status, 'paused');
});

test('all done → stop done', () => {
  const p = parsePlan('### Task 1: a\n- [x] s');
  const d = decide(initialState(), p, now, cfg);
  assert.deepEqual([d.action, d.status], ['stop', 'done']);
});

test('resume after done re-runs when plan gained new task', () => {
  const done = { ...initialState(), status: 'done', reason: 'all done', attempts: { 'Task 1': 1 } };
  const r = resume(done);
  assert.equal(r.status, 'idle');
  assert.equal(r.reason, null);
  assert.deepEqual(r.attempts, {});
  const p = parsePlan('### Task 1: a\n- [x] s\n### Task 5: new\n- [ ] s');
  const d = decide(r, p, now, cfg);
  assert.equal(d.task.id, 'Task 5');
});

test('[planner] task runs like an ordinary one', () => {
  const p = parsePlan(`### Task 1: [planner] Выкладка
- [ ] s`);
  const d = decide(initialState(), p, now, cfg);
  assert.equal(d.action, 'run');
  assert.equal(d.task.kind, 'planner');
});

test('a failure note from the run is kept and becomes the halted reason', () => {
  const p = parsePlan(`### Task 1: [planner] Выкладка
- [ ] s`);
  const t = p.tasks[0];
  let s = initialState();
  for (let i = 0; i < cfg.maxAttempts; i++) {
    s = applyResult(s, t, { kind: 'ok', note: 'НУЖЕН ЧЕЛОВЕК: нет ключа' }, p, now, cfg);
  }
  assert.equal(s.lastNote, 'НУЖЕН ЧЕЛОВЕК: нет ключа');
  const d = decide({ ...s, status: 'idle', nextAttemptAt: null }, p, now, cfg);
  assert.equal(d.status, 'halted');
  assert.match(d.reason, /Task 1 не удалась 3 раз подряд: НУЖЕН ЧЕЛОВЕК: нет ключа/);
});

test('a finished task clears the failure note', () => {
  const s = applyResult({ ...initialState(), lastNote: 'старое' }, task2, { kind: 'ok' }, planTask2Done, now, cfg);
  assert.equal(s.lastNote, null);
});

test('resume forgets the failure note', () => {
  assert.equal(resume({ ...initialState(), status: 'halted', lastNote: 'НУЖЕН ЧЕЛОВЕК: x' }).lastNote, null);
});

// --- Accounts: a limit on one account moves the task to the next one (cfg.accounts) ---

const two = { ...cfg, accounts: [{ name: 'основная' }, { name: 'запасная', configDir: '/tmp/alt' }] };
const pre = { ...initialState(), attempts: { 'Task 2': 1 } };

test('accounts: limit on the primary → idle on the spare, reset noted, attempts unchanged', () => {
  const s = applyResult(pre, task2, { kind: 'limit', resetAt: later }, plan, now, two);
  assert.equal(s.status, 'idle');
  assert.equal(s.account, 'запасная');
  assert.deepEqual(s.accountLimits, { 'основная': later.toISOString() });
  assert.deepEqual(s.attempts, { 'Task 2': 1 });
  assert.equal(s.nextAttemptAt, null);
  const d = decide(s, plan, now, two);
  assert.equal(d.action, 'run');
  assert.equal(d.task.id, 'Task 2');
  assert.deepEqual([d.account, d.switched], ['запасная', null]);
});

test('accounts: limit without resetAt notes now + retryMinutes', () => {
  const s = applyResult(pre, task2, { kind: 'limit' }, plan, now, two);
  assert.equal(s.accountLimits['основная'], new Date(now.getTime() + 15 * 60_000).toISOString());
});

test('accounts: repeated limits without resetAt double the mark (up to 5 h) instead of switching back every retryMinutes', () => {
  const min = m => new Date(now.getTime() + m * 60_000).toISOString();
  let s = applyResult(pre, task2, { kind: 'limit' }, plan, now, two);
  assert.equal(s.accountLimits['основная'], min(15));
  for (const m of [30, 60, 120, 240, 300, 300]) {
    s = applyResult({ ...s, account: 'основная' }, task2, { kind: 'limit' }, plan, now, two);
    assert.equal(s.accountLimits['основная'], min(m));
    assert.equal(s.account, 'запасная');
  }
});

test('accounts: a run on the account that is not a limit forgets its doubled mark', () => {
  const s0 = { ...pre, account: 'основная', accountBackoff: { 'основная': 120, 'запасная': 30 } };
  const ok = applyResult(s0, task2, { kind: 'ok' }, planTask2Done, now, two);
  assert.deepEqual(ok.accountBackoff, { 'запасная': 30 });
  const err = applyResult(s0, task2, { kind: 'error' }, plan, now, two);
  assert.deepEqual(err.accountBackoff, { 'запасная': 30 });
  const s = applyResult(ok, task2, { kind: 'limit' }, plan, now, two);
  assert.equal(s.accountLimits['основная'], new Date(now.getTime() + 15 * 60_000).toISOString());
});

test('accounts: a limit with resetAt uses it and keeps no doubled mark', () => {
  const s = applyResult({ ...pre, accountBackoff: { 'основная': 60 } }, task2, { kind: 'limit', resetAt: later }, plan, now, two);
  assert.equal(s.accountLimits['основная'], later.toISOString());
  assert.deepEqual(s.accountBackoff, {});
});

test('accounts: one account — a limit sleeps as before, no new fields', () => {
  const s = applyResult(pre, task2, { kind: 'limit', resetAt: later }, plan, now, { ...cfg, accounts: [{ name: 'основная' }] });
  assert.equal(s.status, 'sleeping');
  assert.equal(s.nextAttemptAt, later.toISOString());
  assert.equal('account' in s, false);
  assert.equal('accountLimits' in s, false);
  const d = decide(initialState(), plan, now, cfg);
  assert.equal('account' in d, false);
});

test('accounts: limit on the spare while the primary is limited → sleeping until the earliest reset', () => {
  const soon = new Date('2026-10-20T13:00:00Z');
  const s0 = { ...pre, account: 'запасная', accountLimits: { 'основная': soon.toISOString() } };
  const s = applyResult(s0, task2, { kind: 'limit', resetAt: later }, plan, now, two);
  assert.equal(s.status, 'sleeping');
  assert.equal(s.nextAttemptAt, soon.toISOString());
  assert.equal(s.account, 'запасная');
  assert.deepEqual(s.accountLimits, { 'основная': soon.toISOString(), 'запасная': later.toISOString() });
  assert.deepEqual(decide(s, plan, now, two), { action: 'sleep', until: soon });
  const d = decide(s, plan, new Date(soon.getTime() + 1000), two);
  assert.deepEqual([d.action, d.account, d.switched], ['run', 'основная', 'back']);
});

test('accounts: the primary reset has passed → the next task goes back to the primary', () => {
  const s = { ...initialState(), account: 'запасная', accountLimits: { 'основная': now.toISOString() } };
  const d = decide(s, plan, later, two);
  assert.deepEqual([d.action, d.account, d.switched], ['run', 'основная', 'back']);
});

test('accounts: the primary still limited → stays on the spare, no switch', () => {
  const s = { ...initialState(), account: 'запасная', accountLimits: { 'основная': later.toISOString() } };
  const d = decide(s, plan, now, two);
  assert.deepEqual([d.action, d.account, d.switched], ['run', 'запасная', null]);
});

test('accounts: idle with every account limited (e.g. after resume) → sleep until the earliest reset', () => {
  const soon = new Date('2026-10-20T13:00:00Z');
  const s = { ...initialState(), account: 'запасная', accountLimits: { 'основная': later.toISOString(), 'запасная': soon.toISOString() } };
  assert.deepEqual(decide(s, plan, now, two), { action: 'sleep', until: soon });
});

test('accounts: auth on the spare while the primary is limited → sleeping until its reset, spare marked', () => {
  const s0 = { ...pre, account: 'запасная', accountLimits: { 'основная': later.toISOString() } };
  const s = applyResult(s0, task2, { kind: 'auth' }, plan, now, two);
  assert.equal(s.status, 'sleeping');
  assert.equal(s.nextAttemptAt, later.toISOString());
  assert.deepEqual(s.accountAuth, ['запасная']);
  assert.deepEqual(s.attempts, { 'Task 2': 1 });
  assert.match(s.reason, /не авторизована/);
  const d = decide(s, plan, new Date(later.getTime() + 1000), two);
  assert.deepEqual([d.action, d.account, d.switched], ['run', 'основная', 'back']);
});

test('accounts: auth on the spare with the primary free → idle on the primary', () => {
  const s = applyResult({ ...pre, account: 'запасная' }, task2, { kind: 'auth' }, plan, now, two);
  assert.equal(s.status, 'idle');
  assert.equal(s.account, 'основная');
  assert.deepEqual(s.accountAuth, ['запасная']);
});

test('accounts: auth on the primary stops with auth as before', () => {
  const s = applyResult(pre, task2, { kind: 'auth' }, plan, now, two);
  assert.equal(s.status, 'auth');
  assert.equal('accountAuth' in s, false);
});

test('accounts: a spare marked auth is skipped after a primary limit → sleeping', () => {
  const s = applyResult({ ...pre, accountAuth: ['запасная'] }, task2, { kind: 'limit', resetAt: later }, plan, now, two);
  assert.equal(s.status, 'sleeping');
  assert.equal(s.nextAttemptAt, later.toISOString());
});

test('accounts: resume clears the auth mark and keeps the limits', () => {
  const s = { ...initialState(), status: 'halted', account: 'запасная', accountAuth: ['запасная'], accountLimits: { 'основная': later.toISOString() } };
  const r = resume(s);
  assert.equal('accountAuth' in r, false);
  assert.deepEqual(r.accountLimits, { 'основная': later.toISOString() });
  assert.equal(r.account, 'запасная');
});

test('accounts: resume while sleeping on an auth mark drops the mark only', () => {
  const s = { ...initialState(), status: 'sleeping', nextAttemptAt: later.toISOString(), accountAuth: ['запасная'] };
  const r = resume(s);
  assert.equal('accountAuth' in r, false);
  assert.equal(r.status, 'sleeping');
});
