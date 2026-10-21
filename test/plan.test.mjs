import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePlan, nextTask, allDone } from '../lib/plan.mjs';

const sample = readFileSync(new URL('./fixtures/plan-sample.md', import.meta.url), 'utf8');

test('parses tasks with phases', () => {
  const p = parsePlan(sample);
  assert.deepEqual(p.tasks.map(t => t.id), ['Task 1', 'Task 2', 'Task 3', 'Task 4']);
  assert.equal(p.tasks[0].done, true);
  assert.equal(p.tasks[1].done, false);
  assert.equal(p.tasks[1].lastInPhase, true);
  assert.equal(p.tasks[0].lastInPhase, false);
  assert.equal(p.tasks[2].manual, true);
  assert.equal(p.tasks[2].phase, 'Этап 2');
  assert.equal(p.tasks[3].lastInPhase, true);
});

test('nextTask returns first unfinished', () => {
  assert.equal(nextTask(parsePlan(sample)).id, 'Task 2');
});

test('allDone true when every box checked', () => {
  assert.equal(allDone(parsePlan('### Task 1: a\n- [x] s')), true);
  assert.equal(allDone(parsePlan(sample)), false);
});

test('checkboxes in fenced code blocks are ignored', () => {
  const p = parsePlan('### Task 1: a\n- [x] s\n```md\n- [ ] not a step\n```');
  assert.equal(p.tasks[0].done, true);
});

test('task without checkboxes counts as done', () => {
  assert.equal(parsePlan('### Task 1: a\ntext only').tasks[0].done, true);
});

test('tasks report their step counts', () => {
  const p = parsePlan('### Task 1: a\n- [x] s1\n- [ ] s2\n- [X] s3');
  assert.equal(p.tasks[0].boxes, 3);
  assert.equal(p.tasks[0].checked, 2);
});
