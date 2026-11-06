import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listAccounts, accountEnv, pickAccount, pickExecutor, earliestReset } from '../lib/accounts.mjs';

const TWO = [
  { name: 'основная', kind: 'claude', configDir: null, codexHome: null },
  { name: 'запасная', kind: 'claude', configDir: '/tmp/alt', codexHome: null },
];
const NOW = new Date('2026-11-05T10:00:00Z');

test('no accounts in config → one primary account without configDir', () => {
  const primary = [{ name: 'основная', kind: 'claude', configDir: null, codexHome: null }];
  assert.deepEqual(listAccounts({}), primary);
  assert.deepEqual(listAccounts({ accounts: [] }), primary);
});

test('accounts keep config order; missing configDir is null', () => {
  const cfg = { accounts: [{ name: 'основная' }, { name: 'запасная', configDir: '/tmp/alt' }] };
  assert.deepEqual(listAccounts(cfg), TWO);
});

test('empty or repeated account names are a config error', () => {
  assert.throws(() => listAccounts({ accounts: [{ name: '' }] }), /accounts/);
  assert.throws(() => listAccounts({ accounts: [{}] }), /accounts/);
  assert.throws(() => listAccounts({ accounts: [{ name: 'а' }, { name: 'а', configDir: '/x' }] }), /accounts/);
});

test('accountEnv: no configDir → empty env, else CLAUDE_CONFIG_DIR', () => {
  assert.deepEqual(accountEnv(TWO[0]), {});
  assert.deepEqual(accountEnv(TWO[1]), { CLAUDE_CONFIG_DIR: '/tmp/alt' });
});

test('one account, no limits → stays on it, no switch', () => {
  assert.deepEqual(pickAccount(listAccounts({}), {}, NOW), { name: 'основная', switched: null });
});

test('old state without account fields → primary, no switch', () => {
  assert.deepEqual(pickAccount(TWO, { status: 'idle' }, NOW), { name: 'основная', switched: null });
});

test('primary in limit → fallback to spare', () => {
  const state = { account: 'основная', accountLimits: { 'основная': '2026-11-05T12:00:00Z' } };
  assert.deepEqual(pickAccount(TWO, state, NOW), { name: 'запасная', switched: 'fallback' });
});

test('already on spare while primary still limited → no switch', () => {
  const state = { account: 'запасная', accountLimits: { 'основная': '2026-11-05T12:00:00Z' } };
  assert.deepEqual(pickAccount(TWO, state, NOW), { name: 'запасная', switched: null });
});

test('both in limit → null; earliestReset is the nearest reset', () => {
  const state = {
    account: 'запасная',
    accountLimits: { 'основная': '2026-11-05T12:00:00Z', 'запасная': '2026-11-05T11:00:00Z' },
  };
  assert.equal(pickAccount(TWO, state, NOW), null);
  assert.deepEqual(earliestReset(state), new Date('2026-11-05T11:00:00Z'));
});

test('earliestReset without limits → null', () => {
  assert.equal(earliestReset({}), null);
  assert.equal(earliestReset({ accountLimits: {} }), null);
});

test('primary reset has passed → back to primary', () => {
  const state = { account: 'запасная', accountLimits: { 'основная': '2026-11-05T09:59:00Z' } };
  assert.deepEqual(pickAccount(TWO, state, NOW), { name: 'основная', switched: 'back' });
});

test('reset exactly now counts as passed', () => {
  const state = { account: 'запасная', accountLimits: { 'основная': NOW.toISOString() } };
  assert.deepEqual(pickAccount(TWO, state, NOW), { name: 'основная', switched: 'back' });
});

test('spare marked auth and primary limited → null', () => {
  const state = {
    account: 'запасная',
    accountLimits: { 'основная': '2026-11-05T12:00:00Z' },
    accountAuth: ['запасная'],
  };
  assert.equal(pickAccount(TWO, state, NOW), null);
  assert.deepEqual(earliestReset(state), new Date('2026-11-05T12:00:00Z'));
});

test('spare marked auth, primary free → primary', () => {
  const state = { account: 'основная', accountAuth: ['запасная'] };
  assert.deepEqual(pickAccount(TWO, state, NOW), { name: 'основная', switched: null });
});

test('current account gone from config → treated as primary, no switch', () => {
  assert.deepEqual(pickAccount(TWO, { account: 'старая' }, NOW), { name: 'основная', switched: null });
  const limited = { account: 'старая', accountLimits: { 'основная': '2026-11-05T12:00:00Z' } };
  assert.deepEqual(pickAccount(TWO, limited, NOW), { name: 'запасная', switched: 'fallback' });
});

// Codex executor: the codex account plus two Claude accounts, executor set to codex.
const CODEX_CFG = {
  executor: 'codex',
  accounts: [
    { name: 'основная' },
    { name: 'запасная', configDir: '/tmp/alt' },
    { name: 'codex', kind: 'codex', codexHome: '/root/.codex' },
  ],
};
const THREE = listAccounts(CODEX_CFG);
const AUTO = { id: 'Task 3', kind: 'auto' };
const PLANNER = { id: 'Task 1', kind: 'planner' };
const LATER = '2026-11-05T12:00:00Z';

test('codex account: kind codex, codexHome kept, configDir null', () => {
  assert.deepEqual(THREE[2], { name: 'codex', kind: 'codex', configDir: null, codexHome: '/root/.codex' });
  assert.equal(THREE[0].kind, 'claude');
});

test('unknown account kind is a config error', () => {
  assert.throws(() => listAccounts({ accounts: [{ name: 'x', kind: 'gpt' }] }), /accounts/);
});

test('accountEnv: codex account → CODEX_HOME only; codex without home → empty', () => {
  assert.deepEqual(accountEnv(THREE[2]), { CODEX_HOME: '/root/.codex' });
  assert.deepEqual(accountEnv({ name: 'c', kind: 'codex', configDir: null, codexHome: null }), {});
  assert.deepEqual(accountEnv(THREE[1]), { CLAUDE_CONFIG_DIR: '/tmp/alt' });
});

test('executor codex: ordinary task → codex', () => {
  assert.deepEqual(pickExecutor(THREE, {}, AUTO, CODEX_CFG, NOW), { name: 'codex', kind: 'codex', switched: null });
});

test('executor codex: [planner] task → Claude primary, never codex', () => {
  assert.deepEqual(pickExecutor(THREE, {}, PLANNER, CODEX_CFG, NOW), { name: 'основная', kind: 'claude', switched: null });
  const primaryOut = { account: 'codex', accountLimits: { 'основная': LATER } };
  assert.deepEqual(pickExecutor(THREE, primaryOut, PLANNER, CODEX_CFG, NOW), { name: 'запасная', kind: 'claude', switched: 'fallback' });
});

test('executor codex: [planner] task with all Claude accounts out → null even if codex is free', () => {
  const state = { accountLimits: { 'основная': LATER, 'запасная': LATER } };
  assert.equal(pickExecutor(THREE, state, PLANNER, CODEX_CFG, NOW), null);
});

test('codex in limit → Claude primary, switched fallback', () => {
  const state = { account: 'codex', accountLimits: { codex: LATER } };
  assert.deepEqual(pickExecutor(THREE, state, AUTO, CODEX_CFG, NOW), { name: 'основная', kind: 'claude', switched: 'fallback' });
});

test('codex not logged in → Claude, switched fallback', () => {
  const state = { account: 'codex', accountAuth: ['codex'] };
  assert.deepEqual(pickExecutor(THREE, state, AUTO, CODEX_CFG, NOW), { name: 'основная', kind: 'claude', switched: 'fallback' });
});

test('codex and Claude primary in limit → Claude spare', () => {
  const state = { account: 'основная', accountLimits: { codex: LATER, 'основная': LATER } };
  assert.deepEqual(pickExecutor(THREE, state, AUTO, CODEX_CFG, NOW), { name: 'запасная', kind: 'claude', switched: 'fallback' });
});

test('already on Claude while codex still limited → no switch', () => {
  const state = { account: 'основная', accountLimits: { codex: LATER } };
  assert.deepEqual(pickExecutor(THREE, state, AUTO, CODEX_CFG, NOW), { name: 'основная', kind: 'claude', switched: null });
});

test('all executors in limit → null; earliestReset is the nearest of them', () => {
  const state = {
    account: 'запасная',
    accountLimits: { codex: '2026-11-05T11:30:00Z', 'основная': LATER, 'запасная': '2026-11-05T13:00:00Z' },
  };
  assert.equal(pickExecutor(THREE, state, AUTO, CODEX_CFG, NOW), null);
  assert.deepEqual(earliestReset(state), new Date('2026-11-05T11:30:00Z'));
});

test('codex limit reset has passed → back to codex', () => {
  const state = { account: 'основная', accountLimits: { codex: '2026-11-05T09:00:00Z' } };
  assert.deepEqual(pickExecutor(THREE, state, AUTO, CODEX_CFG, NOW), { name: 'codex', kind: 'codex', switched: 'back' });
});

test('[planner] task while on codex → Claude without a switch', () => {
  assert.deepEqual(pickExecutor(THREE, { account: 'codex' }, PLANNER, CODEX_CFG, NOW), { name: 'основная', kind: 'claude', switched: null });
});

test('no executor field → codex account is never picked, Claude as before', () => {
  const cfg = { accounts: CODEX_CFG.accounts };
  const accounts = listAccounts(cfg);
  assert.deepEqual(pickExecutor(accounts, {}, AUTO, cfg, NOW), { name: 'основная', kind: 'claude', switched: null });
  const claudeCfg = { ...cfg, executor: 'claude' };
  assert.deepEqual(pickExecutor(accounts, {}, AUTO, claudeCfg, NOW), { name: 'основная', kind: 'claude', switched: null });
});

test('executor codex without a codex account → Claude as before', () => {
  const cfg = { executor: 'codex', accounts: [{ name: 'основная' }, { name: 'запасная', configDir: '/tmp/alt' }] };
  assert.deepEqual(pickExecutor(TWO, {}, AUTO, cfg, NOW), { name: 'основная', kind: 'claude', switched: null });
});

test('without executor pickExecutor matches pickAccount on old states', () => {
  const states = [
    {},
    { status: 'idle' },
    { account: 'основная', accountLimits: { 'основная': LATER } },
    { account: 'запасная', accountLimits: { 'основная': LATER } },
    { account: 'запасная', accountLimits: { 'основная': '2026-11-05T09:59:00Z' } },
    { account: 'запасная', accountLimits: { 'основная': LATER, 'запасная': LATER } },
    { account: 'старая' },
  ];
  for (const state of states) {
    for (const task of [AUTO, PLANNER]) {
      const old = pickAccount(TWO, state, NOW);
      assert.deepEqual(pickExecutor(TWO, state, task, {}, NOW), old && { ...old, kind: 'claude' }, JSON.stringify(state));
    }
  }
});
