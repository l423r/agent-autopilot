import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listAccounts } from '../lib/accounts.mjs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('config.example.json accounts parse with the real loader', () => {
  const cfg = JSON.parse(read('config.example.json'));
  assert.deepEqual(listAccounts(cfg), [
    { name: 'основная', configDir: null },
    { name: 'запасная', configDir: '/root/.claude-alt' },
  ]);
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
