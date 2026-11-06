import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchLimits, fetchCodexLimits } from '../web/limits.mjs';
import { startServer } from '../web/server.mjs';
import { saveState } from '../lib/state.mjs';

const TOKEN = 'sk-ant-oat01-secret-token';
const USAGE = {
  five_hour: { utilization: 11.0, resets_at: '2026-10-21T18:20:00Z' },
  seven_day: { utilization: 42.5, resets_at: '2026-10-28T06:00:00Z' },
};

let root, credentialsFile, calls;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ap-limits-'));
  credentialsFile = join(root, '.credentials.json');
  writeFileSync(credentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: 'r' } }));
  calls = [];
});

// A fetch stand-in that records requests and answers with `status` and `body`.
const fakeFetch = (status, body) => async (url, opts) => {
  calls.push({ url, opts });
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status });
};

test('fetchLimits: normal answer → percent and reset time of both windows', async () => {
  const limits = await fetchLimits({ credentialsFile, fetchImpl: fakeFetch(200, USAGE) });
  assert.deepEqual(limits, {
    fiveHour: { percent: 11, resetsAt: '2026-10-21T18:20:00Z' },
    week: { percent: 42.5, resetsAt: '2026-10-28T06:00:00Z' },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(calls[0].opts.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].opts.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.ok(calls[0].opts.signal, 'request has a timeout signal');
});

test('fetchLimits: 401 → error without the token', async () => {
  const limits = await fetchLimits({ credentialsFile, fetchImpl: fakeFetch(401, { error: `bad token ${TOKEN}` }) });
  assert.equal(typeof limits.error, 'string');
  assert.match(limits.error, /401/);
  assert.ok(!limits.error.includes(TOKEN));
});

test('fetchLimits: not JSON → error', async () => {
  const limits = await fetchLimits({ credentialsFile, fetchImpl: fakeFetch(200, '<html>oops</html>') });
  assert.equal(typeof limits.error, 'string');
  assert.equal(limits.fiveHour, undefined);
});

test('fetchLimits: other format → error', async () => {
  const limits = await fetchLimits({ credentialsFile, fetchImpl: fakeFetch(200, { five_hour: null }) });
  assert.equal(typeof limits.error, 'string');
});

test('fetchLimits: no credentials file → error, no request', async () => {
  const limits = await fetchLimits({ credentialsFile: join(root, 'missing.json'), fetchImpl: fakeFetch(200, USAGE) });
  assert.equal(typeof limits.error, 'string');
  assert.equal(calls.length, 0);
});

test('fetchLimits: network error mentioning the token → error without the token', async () => {
  const fetchImpl = async () => { throw new Error(`connect failed for Bearer ${TOKEN}`); };
  const limits = await fetchLimits({ credentialsFile, fetchImpl });
  assert.equal(typeof limits.error, 'string');
  assert.ok(!limits.error.includes(TOKEN));
});

let srv;
afterEach(async () => {
  await srv?.close();
  srv = null;
  rmSync(root, { recursive: true, force: true });
});

test('/api/limits: cached for 60 s — two requests, one fetch', async () => {
  const fetchImpl = fakeFetch(200, USAGE);
  const cfg = { projectDir: root, planPath: 'plan.md', autopilotDir: root, stateDir: join(root, 'state') };
  srv = await startServer(cfg, { port: 0, limitsFetch: () => fetchLimits({ credentialsFile, fetchImpl }) });
  const base = `http://127.0.0.1:${srv.port}`;
  const first = await (await fetch(`${base}/api/limits`)).json();
  const second = await (await fetch(`${base}/api/limits`)).json();
  assert.equal(first.accounts.length, 1);
  assert.equal(first.accounts[0].name, 'основная');
  assert.equal(first.accounts[0].active, true);
  assert.deepEqual(first.accounts[0].fiveHour, { percent: 11, resetsAt: '2026-10-21T18:20:00Z' });
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);
});

test('/api/limits: error → 200 { error }, other API still works', async () => {
  const cfg = { projectDir: root, planPath: 'plan.md', autopilotDir: root, stateDir: join(root, 'state') };
  srv = await startServer(cfg, { port: 0, limitsFetch: () => fetchLimits({ credentialsFile, fetchImpl: fakeFetch(401, 'no') }) });
  const base = `http://127.0.0.1:${srv.port}`;
  const res = await fetch(`${base}/api/limits`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.accounts[0].error, 'string');
  assert.ok(!JSON.stringify(body).includes(TOKEN));
  assert.equal((await fetch(`${base}/api/history`)).status, 200);
});

test('/api/limits: per account, the active one from state.json is marked; missing credentials of the spare → error row', async () => {
  const spareDir = join(root, 'alt');
  const stateDir = join(root, 'state');
  const cfg = {
    projectDir: root, planPath: 'plan.md', autopilotDir: root, stateDir,
    accounts: [{ name: 'основная' }, { name: 'запасная', configDir: spareDir }],
  };
  saveState(stateDir, { status: 'idle', account: 'запасная' });
  const files = [];
  const limitsFetch = account => {
    files.push(account.credentialsFile);
    return fetchLimits({ credentialsFile: account.credentialsFile ?? credentialsFile, fetchImpl: fakeFetch(200, USAGE) });
  };
  srv = await startServer(cfg, { port: 0, limitsFetch });
  const body = await (await fetch(`http://127.0.0.1:${srv.port}/api/limits`)).json();
  assert.deepEqual(files, [undefined, join(spareDir, '.credentials.json')]);
  assert.deepEqual(body.accounts.map(a => [a.name, a.active]), [['основная', false], ['запасная', true]]);
  assert.deepEqual(body.accounts[0].fiveHour, { percent: 11, resetsAt: '2026-10-21T18:20:00Z' });
  assert.equal(body.accounts[1].fiveHour, undefined);
  assert.match(body.accounts[1].error, /токен/i);
  assert.equal(calls.length, 1, 'only the primary reached the network');
  assert.ok(!JSON.stringify(body).includes(TOKEN));
});

test('/api/limits: no state.json → the primary is active', async () => {
  const cfg = {
    projectDir: root, planPath: 'plan.md', autopilotDir: root, stateDir: join(root, 'state'),
    accounts: [{ name: 'основная' }, { name: 'запасная', configDir: join(root, 'alt') }],
  };
  srv = await startServer(cfg, { port: 0, limitsFetch: async () => ({ error: 'x' }) });
  const body = await (await fetch(`http://127.0.0.1:${srv.port}/api/limits`)).json();
  assert.deepEqual(body.accounts.map(a => a.active), [true, false]);
});

// --- Codex limits: the newest rate_limits event in $CODEX_HOME/sessions ---
const rl = (p5, p7, at = 1792000000) => ({
  timestamp: '2026-11-06T10:00:00Z', type: 'event_msg',
  payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex',
    primary: { used_percent: p5, window_minutes: 300, resets_at: at },
    secondary: { used_percent: p7, window_minutes: 10080, resets_at: at + 86400 } } },
});
const session = (home, day, name, events, mtime) => {
  const dir = join(home, 'sessions', '2026', '11', day);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, events.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n') + '\n');
  utimesSync(file, mtime, mtime);
};

test('fetchCodexLimits: newest session, last event with rate_limits', () => {
  const home = join(root, 'codex');
  session(home, '05', 'rollout-old.jsonl', [rl(90, 90)], 1000);
  session(home, '06', 'rollout-new.jsonl', [rl(10, 20), { type: 'other' }, rl(30, 40), 'not json'], 2000);
  assert.deepEqual(fetchCodexLimits({ codexHome: home }), {
    fiveHour: { percent: 30, resetsAt: new Date(1792000000 * 1000).toISOString() },
    week: { percent: 40, resetsAt: new Date((1792000000 + 86400) * 1000).toISOString() },
  });
});

test('fetchCodexLimits: newest file without events → falls back to an older one', () => {
  const home = join(root, 'codex');
  session(home, '05', 'rollout-old.jsonl', [rl(55, 66)], 1000);
  session(home, '06', 'rollout-new.jsonl', [{ type: 'other' }], 2000);
  assert.equal(fetchCodexLimits({ codexHome: home }).fiveHour.percent, 55);
});

test('fetchCodexLimits: no directory / no events → «нет данных», no throw', () => {
  const none = { error: 'Нет данных о лимитах Codex' };
  assert.deepEqual(fetchCodexLimits({ codexHome: join(root, 'missing') }), none);
  const home = join(root, 'empty');
  session(home, '06', 'rollout-x.jsonl', [{ type: 'other' }], 2000);
  assert.deepEqual(fetchCodexLimits({ codexHome: home }), none);
});

test('/api/limits: codex account → its own row, marked as executor, no network call', async () => {
  const home = join(root, 'codex');
  session(home, '06', 'rollout-new.jsonl', [rl(12, 34)], 2000);
  const cfg = {
    projectDir: root, planPath: 'plan.md', autopilotDir: root, stateDir: join(root, 'state'), executor: 'codex',
    accounts: [{ name: 'основная' }, { name: 'codex', kind: 'codex', codexHome: home }],
  };
  const seen = [];
  srv = await startServer(cfg, { port: 0, limitsFetch: a => { seen.push(a.name); return fetchLimits({ credentialsFile, fetchImpl: fakeFetch(200, USAGE) }); } });
  const body = await (await fetch(`http://127.0.0.1:${srv.port}/api/limits`)).json();
  assert.deepEqual(seen, ['основная']);
  const row = body.accounts[1];
  assert.equal(row.name, 'codex');
  assert.equal(row.executor, true);
  assert.equal(row.fiveHour.percent, 12);
  assert.equal(row.week.percent, 34);
  assert.equal(body.accounts[0].executor, undefined);
});
