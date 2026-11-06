import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify, parseResetTime, usageOf } from '../lib/classify.mjs';

const cfg = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
const now = new Date('2026-10-20T12:00:00Z');
const iso = d => d && d.toISOString();

test('epoch format', () => {
  assert.equal(parseResetTime('Claude AI usage limit reached|1792512000', now).getTime(), 1792512000 * 1000);
});
test('pm today', () => {
  assert.equal(iso(parseResetTime('5-hour limit reached ∙ resets 3pm', now)), '2026-10-20T15:00:00.000Z');
});
test('time already passed today → tomorrow', () => {
  assert.equal(iso(parseResetTime('resets at 09:00', now)), '2026-10-21T09:00:00.000Z');
});
test('zone in parens', () => {
  assert.equal(iso(parseResetTime('resets 6pm (Europe/Moscow)', now)), '2026-10-20T15:00:00.000Z');
});
test('minutes with am/pm', () => {
  assert.equal(iso(parseResetTime('resets 3:30pm', now)), '2026-10-20T15:30:00.000Z');
});
test('date + time', () => {
  assert.equal(iso(parseResetTime('Weekly limit reached ∙ resets Oct 22, 9am', now)), '2026-10-22T09:00:00.000Z');
  assert.equal(iso(parseResetTime('resets Oct 22 at 09:00', now)), '2026-10-22T09:00:00.000Z');
});
test('garbage → null', () => {
  assert.equal(parseResetTime('hello', now), null);
});
test('unknown limit text → limit без resetAt', () => {
  assert.deepEqual(classify({ exitCode: 1, output: 'Usage limit reached. Try later.', timedOut: false }, now, cfg), { kind: 'limit' });
});
test('resetAt in the past is dropped', () => {
  const r = classify({ exitCode: 1, output: 'usage limit reached|1700000000', timedOut: false }, now, cfg);
  assert.equal(r.kind, 'limit');
  assert.equal(r.resetAt, undefined);
});
test('resetAt more than 8 days ahead is dropped', () => {
  const r = classify({ exitCode: 1, output: `usage limit reached|${Math.floor(now.getTime() / 1000) + 9 * 86400}`, timedOut: false }, now, cfg);
  assert.equal(r.resetAt, undefined);
});
test('limit with valid reset keeps resetAt', () => {
  const r = classify({ exitCode: 1, output: 'limit reached ∙ resets 3pm', timedOut: false }, now, cfg);
  assert.equal(iso(r.resetAt), '2026-10-20T15:00:00.000Z');
});
test('auth wins over limit', () => {
  assert.equal(classify({ exitCode: 1, output: 'OAuth token has expired. Please run /login', timedOut: false }, now, cfg).kind, 'auth');
});
test('timeout', () => {
  assert.equal(classify({ exitCode: null, output: '', timedOut: true }, now, cfg).kind, 'timeout');
});
test('ok', () => {
  assert.equal(classify({ exitCode: 0, output: '{"result":"done"}', timedOut: false }, now, cfg).kind, 'ok');
});
test('nonzero without patterns → error', () => {
  assert.equal(classify({ exitCode: 2, output: 'boom', timedOut: false }, now, cfg).kind, 'error');
});
test('successful run whose text mentions limits stays ok', () => {
  const out = JSON.stringify({ type: 'result', is_error: false, result: 'Implemented usage limit parsing, resets 3pm handled' });
  assert.equal(classify({ exitCode: 0, output: out, timedOut: false }, now, cfg).kind, 'ok');
});
test('failed run mentioning another service authentication is an error, not auth', () => {
  assert.equal(classify({ exitCode: 1, output: 'eas build failed: Expo authentication required', timedOut: false }, now, cfg).kind, 'error');
});
test('claude login prompt is auth', () => {
  assert.equal(classify({ exitCode: 1, output: 'Invalid API key · Please run /login', timedOut: false }, now, cfg).kind, 'auth');
});

const fixture = name => readFileSync(new URL(`./fixtures/codex/${name}.jsonl`, import.meta.url), 'utf8');
const codex = (name, exitCode = name === 'ok' ? 0 : 1) => classify({ exitCode, output: fixture(name), timedOut: false }, now, cfg, 'codex');

test('codex: turn.completed is ok, even with limit/auth words in the agent text and a transient error', () => {
  assert.deepEqual(codex('ok'), { kind: 'ok' });
});
test('codex: turn.failed without limit or auth → error with the failure message', () => {
  assert.deepEqual(codex('error'), { kind: 'error', detail: 'stream disconnected before completion: Transport error: network error' });
});
test('codex: usage limit takes resetAt from the exhausted rate_limits window', () => {
  const r = codex('limit-rate-limits');
  assert.equal(r.kind, 'limit');
  assert.equal(iso(r.resetAt), '2026-10-20T15:00:00.000Z');
});
test('codex: both windows exhausted → the later reset', () => {
  const out = fixture('limit-rate-limits').replace('"used_percent":41.0', '"used_percent":100.0');
  const r = classify({ exitCode: 1, output: out, timedOut: false }, now, cfg, 'codex');
  assert.equal(iso(r.resetAt), '2026-10-24T12:00:00.000Z');
});
test('codex: usage limit with «try again at <date>» in the message', () => {
  const r = codex('limit-try-again');
  assert.equal(r.kind, 'limit');
  assert.equal(iso(r.resetAt), '2026-10-22T09:00:00.000Z');
});
test('codex: usage limit without a time → limit without resetAt', () => {
  assert.deepEqual(codex('limit-no-time'), { kind: 'limit' });
});
test('codex: 401 Unauthorized → auth', () => {
  assert.deepEqual(codex('auth'), { kind: 'auth' });
});
test('codex: exit 0 but turn.failed → not ok', () => {
  assert.equal(codex('limit-no-time', 0).kind, 'limit');
});
test('codex: crash without JSON → error with the output tail', () => {
  const output = 'x'.repeat(1000) + "\nthread 'main' panicked at exec/src/lib.rs:1: boom\n";
  const r = classify({ exitCode: 101, output, timedOut: false }, now, cfg, 'codex');
  assert.equal(r.kind, 'error');
  assert.ok(r.detail.endsWith("thread 'main' panicked at exec/src/lib.rs:1: boom"));
  assert.ok(r.detail.length <= 500);
});
test('codex: killed mid-turn — limit/auth words in the agent output are not the failure', () => {
  const item = text => JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: "bash -lc 'npm test'", aggregated_output: text, exit_code: 0, status: 'completed' } });
  const head = '{"type":"thread.started","thread_id":"t"}\n{"type":"turn.started"}\n';
  for (const words of ['ok 7 - codex: not logged in → auth\n', 'ok 8 - You\'ve hit your usage limit → limit\n']) {
    const r = classify({ exitCode: 137, output: head + item(words) + '\n', timedOut: false }, now, cfg, 'codex');
    assert.equal(r.kind, 'error', words);
  }
});
test('codex: JSON events plus a plain-text failure line on stderr → still matched', () => {
  const output = '{"type":"thread.started","thread_id":"t"}\nError: Not logged in. Run codex login\n';
  assert.deepEqual(classify({ exitCode: 1, output, timedOut: false }, now, cfg, 'codex'), { kind: 'auth' });
});
test('codex: plain-text «Not logged in» without JSON → auth', () => {
  assert.deepEqual(classify({ exitCode: 1, output: 'Error: Not logged in. Run codex login\n', timedOut: false }, now, cfg, 'codex'), { kind: 'auth' });
});
test('codex: timeout', () => {
  assert.deepEqual(classify({ exitCode: null, output: fixture('ok'), timedOut: true }, now, cfg, 'codex'), { kind: 'timeout' });
});
test('codex: a 401 for Claude stays under Claude patterns (no codex auth rules)', () => {
  assert.equal(classify({ exitCode: 1, output: fixture('auth'), timedOut: false }, now, cfg).kind, 'error');
});
test('codex usage: tokens from turn.completed, no cost', () => {
  assert.deepEqual(usageOf(fixture('ok'), 'codex'), { tokens: { input: 1200, output: 300, cacheRead: 800, cacheWrite: null }, costUsd: null });
  assert.deepEqual(usageOf('garbage', 'codex'), { tokens: null, costUsd: null });
});
