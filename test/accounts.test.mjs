import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listAccounts, accountEnv, pickAccount, earliestReset } from '../lib/accounts.mjs';

const TWO = [{ name: 'основная', configDir: null }, { name: 'запасная', configDir: '/tmp/alt' }];
const NOW = new Date('2026-11-05T10:00:00Z');

test('no accounts in config → one primary account without configDir', () => {
  assert.deepEqual(listAccounts({}), [{ name: 'основная', configDir: null }]);
  assert.deepEqual(listAccounts({ accounts: [] }), [{ name: 'основная', configDir: null }]);
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
