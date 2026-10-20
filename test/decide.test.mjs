import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePlan } from '../lib/plan.mjs';
import { decide, applyResult, resume, initialState } from '../lib/decide.mjs';

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
  assert.equal(s.status, 'idle');
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
