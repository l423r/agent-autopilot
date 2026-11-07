import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listAccounts } from '../lib/accounts.mjs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('config.example.json accounts parse with the real loader', () => {
  const cfg = JSON.parse(read('config.example.json'));
  assert.deepEqual(listAccounts(cfg), [
    { name: 'основная', kind: 'claude', configDir: null, codexHome: null },
    { name: 'запасная', kind: 'claude', configDir: '/root/.claude-alt', codexHome: null },
    { name: 'codex', kind: 'codex', configDir: null, codexHome: '/root/.codex' },
  ]);
});

test('config.example.json shows the codex executor', () => {
  const cfg = JSON.parse(read('config.example.json'));
  assert.equal(cfg.executor, 'codex');
});

test('README has the codex executor section', () => {
  const readme = read('README.md');
  const section = readme.split('\n## ').find(s => s.startsWith('Codex — исполнитель'));
  assert.ok(section, 'нет раздела «Codex — исполнитель»');
  for (const must of [
    'executor',
    'kind',
    'codexModels',
    'codex login --device-auth',
    'Лимит Codex',
    'Вернулся на Codex',
    'stats',
    '[planner]',
  ]) {
    assert.ok(section.includes(must), `в разделе нет «${must}»`);
  }
});

test('planner prompt tells the planner how to write steps for Codex', () => {
  const prompt = read('web/planner-prompt.md');
  assert.ok(prompt.includes('Codex'), 'нет упоминания Codex');
  assert.ok(prompt.includes('свежий ревьюер в новой сессии'), 'нет указания про ревью в новой сессии');
});

test('README has the spare-account section with its setup, login and status lines', () => {
  const readme = read('README.md');
  const section = readme.split('\n## ').find(s => s.startsWith('Запасная учётка'));
  assert.ok(section, 'нет раздела «Запасная учётка»');
  for (const must of [
    'accounts',
    'scripts/setup-alt-account.sh',
    'CLAUDE_CONFIG_DIR=/root/.claude-alt claude',
    '/login',
    'Учётка:',
    'Лимит:',
  ]) {
    assert.ok(section.includes(must), `в разделе нет «${must}»`);
  }
});

test('README documents the current status view and temporary-file cleanup', () => {
  const readme = read('README.md');
  const now = readme.split('\n## ').find(s => s.startsWith('Что сейчас делает автопилот'));
  assert.ok(now, 'нет раздела «Что сейчас делает автопилот»');
  for (const must of [
    'Сейчас', 'heartbeatAt', 'run', 'Работает:', 'Ждёт лимит', 'Ждёт тебя',
    'Остановился:', 'На паузе', 'Не отвечает', 'очередь пуста', 'все планы в очереди ждут тебя', 'Нужен вход',
  ]) {
    assert.ok(now.includes(must), `в разделе «Сейчас» нет «${must}»`);
  }

  const tmp = readme.split('\n## ').find(s => s.startsWith('Временные файлы'));
  assert.ok(tmp, 'нет раздела «Временные файлы»');
  for (const must of ['/var/tmp/autopilot/<stamp>-<taskId>', 'TMPDIR', '/tmp', '70%', '12 ч', 'systemd-tmpfiles', '1d']) {
    assert.ok(tmp.includes(must), `в разделе «Временные файлы» нет «${must}»`);
  }
});
