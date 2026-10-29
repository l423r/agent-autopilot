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

test('model mark in task heading', () => {
  const t = md => parsePlan(md).tasks[0];
  assert.deepEqual(
    (({ title, model }) => ({ title, model }))(t('### Task 4: Заявки · model: sonnet')),
    { title: 'Заявки', model: 'sonnet' },
  );
  assert.equal(t('### Task 5: Фото | MODEL: Opus').model, 'opus');
  const m = t('### Task 9: Выкладка [manual] · model: haiku');
  assert.equal(m.manual, true);
  assert.equal(m.model, 'haiku');
  assert.equal(m.title, 'Выкладка');
  const plain = t('### Task 6: Модель данных');
  assert.equal(plain.model, null);
  assert.equal(plain.title, 'Модель данных');
  const bad = t('### Task 7: Выбор · model: gpt');
  assert.equal(bad.model, null);
  assert.match(bad.title, /model: gpt/);
});

test('model mark before [manual] is also parsed', () => {
  const t = parsePlan('### Task 9: Выкладка · model: haiku [manual]').tasks[0];
  assert.equal(t.manual, true);
  assert.equal(t.model, 'haiku');
  assert.equal(t.title, 'Выкладка');
});
