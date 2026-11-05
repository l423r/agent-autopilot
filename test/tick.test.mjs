import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, tickStep } from '../lib/plan.mjs';

const plan = [
  '# План',
  '',
  '### Task 1: Код · model: sonnet',
  '',
  '- [ ] **Step 1:** тесты',
  '',
  '### Task 2: [planner] Выкладка',
  '',
  '- [ ] **Step 1:** перезапуск',
  '',
  '### Task 3: [manual] Посмотреть видео',
  '',
  'Видео: https://example.com/v?a=1&b=2',
  '',
  '- [ ] **Step 1:** посмотреть',
  '- [ ] **Step 2:** проверить звук',
  '',
].join('\n');

const diffCount = (a, b) => {
  assert.equal(a.length, b.length);
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
};

test('tickStep ticks one step of a manual task, rest byte for byte', () => {
  const r = tickStep(plan, 'Task 3', 1);
  assert.equal(r.error, undefined);
  assert.equal(r.taskDone, false);
  assert.equal(diffCount(plan, r.markdown), 1);
  assert.match(r.markdown, /- \[x\] \*\*Step 1:\*\* посмотреть/);
  assert.match(r.markdown, /- \[ \] \*\*Step 2:\*\* проверить звук/);
  const t = parsePlan(r.markdown).tasks[2];
  assert.equal(t.checked, 1);
});

test('tickStep on the last step reports taskDone', () => {
  const once = tickStep(plan, 'Task 3', 2);
  assert.equal(once.taskDone, false);
  const twice = tickStep(once.markdown, 'Task 3', 1);
  assert.equal(twice.taskDone, true);
  assert.equal(parsePlan(twice.markdown).tasks[2].done, true);
});

test('tickStep refuses planner and auto tasks', () => {
  assert.deepEqual(tickStep(plan, 'Task 1', 1), { error: 'not-manual' });
  assert.deepEqual(tickStep(plan, 'Task 2', 1), { error: 'not-manual' });
});

test('tickStep: unknown task and step', () => {
  assert.deepEqual(tickStep(plan, 'Task 9', 1), { error: 'no-task' });
  assert.deepEqual(tickStep(plan, 'Task 3', 3), { error: 'no-step' });
  assert.deepEqual(tickStep(plan, 'Task 3', 0), { error: 'no-step' });
  assert.deepEqual(tickStep(plan, 'Task 3', 1.5), { error: 'no-step' });
});

test('tickStep: already ticked step', () => {
  const r = tickStep(plan, 'Task 3', 1);
  assert.deepEqual(tickStep(r.markdown, 'Task 3', 1), { error: 'already' });
  const upper = plan.replace('- [ ] **Step 1:** посмотреть', '- [X] **Step 1:** посмотреть');
  assert.deepEqual(tickStep(upper, 'Task 3', 1), { error: 'already' });
});

test('tickStep keeps CRLF line endings', () => {
  const crlf = plan.replace(/\n/g, '\r\n');
  const r = tickStep(crlf, 'Task 3', 2);
  assert.equal(diffCount(crlf, r.markdown), 1);
  assert.equal(r.markdown.split('\r\n').length, crlf.split('\r\n').length);
  assert.match(r.markdown, /- \[x\] \*\*Step 2:\*\* проверить звук\r\n/);
});

test('tickStep numbers nested boxes like parsePlan and skips fenced ones', () => {
  const md = [
    '### Task 4: Покупка [manual]',
    '- [ ] Step 1',
    '  - [ ] вложенный',
    '```',
    '- [ ] в коде, не шаг',
    '```',
    '* [ ] Step 3',
  ].join('\n');
  assert.equal(parsePlan(md).tasks[0].boxes, 3);
  const r = tickStep(md, 'Task 4', 2);
  assert.equal(diffCount(md, r.markdown), 1);
  assert.match(r.markdown, /^ {2}- \[x\] вложенный$/m);
  assert.match(r.markdown, /^- \[ \] в коде, не шаг$/m);
  const r3 = tickStep(md, 'Task 4', 3);
  assert.match(r3.markdown, /^\* \[x\] Step 3$/m);
  assert.match(r3.markdown, /^- \[ \] в коде, не шаг$/m);
});

test('tickStep treats [planner] with autopilot restart as manual, like parsePlan', () => {
  const md = [
    '### Task 8: [planner] Включение',
    '- [ ] **Step 1:** `systemctl restart agent-autopilot`',
  ].join('\n');
  assert.equal(parsePlan(md).tasks[0].kind, 'user');
  assert.equal(tickStep(md, 'Task 8', 1).taskDone, true);
});
