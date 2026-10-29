import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, modelFor, validateModelConfig } from '../lib/models.mjs';

test('MODELS is the escalation ladder', () => {
  assert.deepEqual(MODELS, ['haiku', 'sonnet', 'opus']);
});

test('haiku escalates one step per attempt, capped at opus', () => {
  const t = { model: 'haiku' };
  assert.equal(modelFor(t, 1, {}), 'haiku');
  assert.equal(modelFor(t, 2, {}), 'sonnet');
  assert.equal(modelFor(t, 3, {}), 'opus');
  assert.equal(modelFor(t, 5, {}), 'opus');
});

test('sonnet on attempt 2 → opus', () => {
  assert.equal(modelFor({ model: 'sonnet' }, 2, {}), 'opus');
});

test('no mark and no defaultModel → null, no escalation', () => {
  assert.equal(modelFor({ model: null }, 3, {}), null);
});

test('defaultModel applies to unmarked tasks and escalates', () => {
  assert.equal(modelFor({ model: null }, 1, { defaultModel: 'sonnet' }), 'sonnet');
  assert.equal(modelFor({ model: null }, 2, { defaultModel: 'sonnet' }), 'opus');
});

test('task mark wins over defaultModel', () => {
  assert.equal(modelFor({ model: 'haiku' }, 1, { defaultModel: 'opus' }), 'haiku');
});

test('restart mid-attempt: counted attempt makes the next run one step higher', () => {
  const state = { attempts: { 'Task 4': 1 } };
  const task = { id: 'Task 4', model: 'haiku' };
  const attempt = (state.attempts[task.id] ?? 0) + 1;
  assert.equal(attempt, 2);
  assert.equal(modelFor(task, attempt, {}), 'sonnet');
});

test('validateModelConfig rejects unknown defaultModel', () => {
  assert.throws(() => validateModelConfig({ defaultModel: 'gpt' }), { message: 'defaultModel: допустимо haiku, sonnet, opus' });
  assert.doesNotThrow(() => validateModelConfig({}));
  assert.doesNotThrow(() => validateModelConfig({ defaultModel: 'opus' }));
});
