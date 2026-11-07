import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nowView, nowShort } from '../lib/now.mjs';

const now = new Date(2026, 10, 8, 12, 0, 0);
const ago = ms => new Date(+now - ms).toISOString();
const state = { status: 'idle', heartbeatAt: ago(1000) };
const run = {
  project: 'alpha', planTitle: 'Пример X', planPath: 'plans/x.md',
  taskId: 'Task 3', taskTitle: 'Понятный статус', total: 9, done: 2,
  executor: 'codex', model: 'gpt-5', attempt: 2, maxAttempts: 3,
  startedAt: ago(125000), lastOutputAt: ago(30000),
};
const active = { project: 'alpha', planTitle: 'Пример X', active: true, next: { id: 'Task 3', title: 'Понятный статус' } };
const waiting = { project: 'beta', planTitle: 'Второй план', waiting: { id: 'Task 7', title: 'Проверить' } };
const view = (changes = {}, queue = []) => nowView({ state: { ...state, ...changes }, queue, now });
const result = (kind, title, details = [], action = null) => ({ kind, title, details, action });

test('nowView: stale heartbeat beats a stale running run; exactly three minutes is alive', () => {
  assert.deepEqual(view({ status: 'running', run, heartbeatAt: ago(180001) }), result('down',
    'Автопилот не отвечает с 11:56', ['Служба остановлена или зависла. Напиши планировщику «проверь автопилот».']));
  assert.equal(view({ status: 'running', run, heartbeatAt: ago(180000) }).kind, 'working');
});

test('nowView: legacy state without new fields and invalid heartbeat do not throw', () => {
  for (const heartbeatAt of [undefined, null, 'invalid']) {
    assert.deepEqual(view({ status: 'running', heartbeatAt }), result('down',
      'Автопилот не отвечает с —', ['Служба остановлена или зависла. Напиши планировщику «проверь автопилот».']));
  }
});

test('nowView: working text is literal for Codex and Claude, duration and output age', () => {
  assert.deepEqual(view({ status: 'running', run }), result('working', 'Работает: alpha — «Пример X»', [
    'Task 3 из 9: Понятный статус', 'Codex gpt-5 · попытка 2 из 3 · идёт 2 мин', 'Последний вывод 30 с назад',
  ]));
  assert.deepEqual(view({ status: 'running', run: { ...run, executor: 'claude', model: 'opus', lastOutputAt: ago(60000) } }),
    result('working', 'Работает: alpha — «Пример X»', [
      'Task 3 из 9: Понятный статус', 'Claude opus · попытка 2 из 3 · идёт 2 мин', 'Последний вывод 1 мин назад',
    ]));
});

test('nowView: no-output warning at 10 min 1 sec, absent at 9 min 59 sec and exactly 10 min', () => {
  for (const [age, warn] of [[599000, false], [600000, false], [601000, true]]) {
    const got = view({ status: 'running', run: { ...run, lastOutputAt: ago(age) } });
    assert.equal(got.details.length, warn ? 4 : 3);
    if (warn) assert.equal(got.details[3], '⚠ Давно нет вывода — возможно, задача зависла');
  }
});

test('nowView: sleeping names the active next task, skips waiting and finished plans', () => {
  assert.deepEqual(view({ status: 'sleeping', nextAttemptAt: new Date(2026, 10, 8, 13, 5).toISOString() },
    [waiting, { project: 'done', next: null }, active]), result('limit',
    'Ждёт лимит до 13:05, дальше продолжит сам', ['Следующая: alpha — Task 3: Понятный статус']));
});

test('nowView: local time on another date includes literal Russian date', () => {
  const yesterday = new Date(2026, 10, 7, 9, 4).toISOString();
  assert.equal(view({ heartbeatAt: yesterday }).title, 'Автопилот не отвечает с 7 нояб., 09:04');
  assert.equal(view({ status: 'sleeping', nextAttemptAt: yesterday }).title, 'Ждёт лимит до 7 нояб., 09:04, дальше продолжит сам');
});

test('nowView: long waiting-user with fresh heartbeat is user, counts only waiting plans', () => {
  assert.deepEqual(view({ status: 'waiting-user', updatedAt: ago(86400000) }, [active, waiting, { ...waiting, project: 'gamma' }]),
    result('user', 'Ничего не делает: все планы в очереди ждут тебя (2)', [
      'beta — «Второй план», Task 7: Проверить', 'gamma — «Второй план», Task 7: Проверить',
    ]));
});

test('nowView: halted and paused ignore stale run, offer resume; auth shows reason', () => {
  assert.deepEqual(view({ status: 'halted', reason: 'три ошибки', currentTask: 'Task 3', run }, [active]),
    result('stuck', 'Остановился: три ошибки', ['Задача Task 3 в «Пример X»'], 'resume'));
  assert.deepEqual(view({ status: 'paused', run }), result('paused', 'На паузе', ['Продолжит после кнопки «Продолжить»'], 'resume'));
  assert.deepEqual(view({ status: 'auth', reason: 'Войдите в Codex' }), result('auth', 'Нужен вход в учётку', ['Войдите в Codex']));
});

test('nowView: done/idle empty queue and transition states never claim work', () => {
  for (const status of ['done', 'idle']) assert.deepEqual(view({ status, run }), result('idle', 'Ничего не делает: очередь пуста'));
  assert.deepEqual(view({ status: 'running', run: null }), result('idle', 'Ничего не делает: нет текущего запуска'));
  assert.deepEqual(view({}, [active]), result('idle', 'Ничего не делает: ждёт следующего запуска'));
});

test('nowShort: all header variants', () => {
  const cases = [
    [{ status: 'running', run }, [], 'работает · alpha Task 3'],
    [{ status: 'sleeping', nextAttemptAt: new Date(2026, 10, 8, 13, 5).toISOString() }, [active], 'ждёт лимит до 13:05'],
    [{ status: 'waiting-user' }, [waiting], 'ждёт тебя (1)'],
    [{ status: 'halted' }, [active], 'остановился'],
    [{ status: 'paused' }, [], 'пауза'],
    [{ heartbeatAt: ago(180001) }, [], 'не отвечает'],
    [{}, [], 'очередь пуста'],
    [{ status: 'auth' }, [], 'нужен вход в учётку'],
  ];
  for (const [changes, queue, short] of cases) {
    const s = { ...state, ...changes };
    assert.equal(nowShort(nowView({ state: s, queue, now }), s), short);
  }
});

test('nowView is pure: frozen inputs can be reused', () => {
  const s = Object.freeze({ ...state, status: 'running', run: Object.freeze(run) });
  const q = Object.freeze([Object.freeze(active)]);
  assert.deepEqual(nowView({ state: s, queue: q, now }), nowView({ state: s, queue: q, now }));
});
