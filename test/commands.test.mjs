import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan } from '../lib/plan.mjs';
import { initialState } from '../lib/decide.mjs';
import { parseCommand, applyCommand, statusText } from '../lib/commands.mjs';

const idle = initialState();
const ctx = { busy: false, summary: 'Статус: idle' };

test('parseCommand recognises whitelisted words, case and edge spaces ignored', () => {
  assert.equal(parseCommand(' Статус '), 'status');
  assert.equal(parseCommand('?'), 'status');
  assert.equal(parseCommand('STOP'), 'pause');
  assert.equal(parseCommand('дальше'), 'resume');
});

test('parseCommand rejects everything else', () => {
  assert.equal(parseCommand('rm -rf /'), null);
  assert.equal(parseCommand(''), null);
  assert.equal(parseCommand('статус'.padEnd(10_000, 'x')), null);
  assert.equal(parseCommand('x'.repeat(10_000)), null);
  assert.equal(parseCommand(undefined), null);
});

test('pause when idle stops now', () => {
  const r = applyCommand('pause', idle, ctx);
  assert.equal(r.state.status, 'paused');
  assert.match(r.state.reason, /по команде/);
  assert.equal(r.pauseAfterTask, false);
});

test('pause while a task runs waits for the task', () => {
  const r = applyCommand('pause', { ...idle, status: 'running', currentTask: 'Task 2' }, { ...ctx, busy: true });
  assert.equal(r.state, null);
  assert.equal(r.pauseAfterTask, true);
  assert.match(r.reply.message, /Task 2/);
});

test('pause when already stopped changes nothing', () => {
  const r = applyCommand('pause', { ...idle, status: 'halted' }, ctx);
  assert.equal(r.state, null);
  assert.equal(r.pauseAfterTask, false);
  assert.match(r.reply.message, /уже остановлен/);
});

test('resume clears halted attempts', () => {
  const r = applyCommand('resume', { ...idle, status: 'halted', attempts: { 'Task 2': 3 }, reason: 'x' }, ctx);
  assert.equal(r.state.status, 'idle');
  assert.deepEqual(r.state.attempts, {});
});

test('resume wakes a sleeping autopilot', () => {
  const r = applyCommand('resume', { ...idle, status: 'sleeping', nextAttemptAt: '2026-10-21T15:00:00.000Z' }, ctx);
  assert.equal(r.state.status, 'idle');
  assert.equal(r.state.nextAttemptAt, null);
});

test('resume while busy changes nothing', () => {
  const r = applyCommand('resume', { ...idle, status: 'running', currentTask: 'Task 2' }, { ...ctx, busy: true });
  assert.equal(r.state, null);
  assert.match(r.reply.message, /уже работаю/);
  assert.ok(!r.cancelPause);
});

test('resume while busy cancels a pending pause', () => {
  const r = applyCommand('resume', { ...idle, status: 'running', currentTask: 'Task 2' }, { ...ctx, busy: true, pausePending: true });
  assert.equal(r.state, null);
  assert.equal(r.cancelPause, true);
  assert.match(r.reply.message, /Пауза отменена/);
});

test('status replies with the summary', () => {
  const r = applyCommand('status', idle, ctx);
  assert.equal(r.state, null);
  assert.equal(r.pauseAfterTask, false);
  assert.equal(r.reply.message, ctx.summary);
});

test('unknown command lists the known ones', () => {
  const r = applyCommand(null, idle, ctx);
  assert.equal(r.state, null);
  assert.match(r.reply.message, /статус, пауза, продолжить/);
});

test('statusText shows progress and next task', () => {
  const plan = parsePlan(['## Этап 1. A', ...[1, 2, 3, 4, 5].map(n => `### Task ${n}: t${n}\n- [${n <= 3 ? 'x' : ' '}] s`)].join('\n'));
  const text = statusText({ ...idle, status: 'sleeping', nextAttemptAt: '2026-10-21T15:00:00.000Z' }, plan);
  assert.match(text, /3\/5/);
  assert.match(text, /Task 4/);
  assert.match(text, /2026-10-21T15:00/);
  const lines = text.split('\n').length;
  assert.ok(lines >= 2 && lines <= 4, `lines: ${lines}`);
});

test('statusText: модель текущей задачи', () => {
  const plan = parsePlan('### Task 4: Заявки · model: sonnet\n- [ ] s');
  const running = { ...idle, status: 'running', currentTask: 'Task 4' };
  assert.match(statusText({ ...running, currentModel: 'sonnet' }, plan), /^Текущая задача: Task 4 \(sonnet\)$/m);
  assert.match(statusText(running, plan), /^Текущая задача: Task 4$/m);
});
