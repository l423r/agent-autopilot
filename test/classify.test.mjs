import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify, parseResetTime } from '../lib/classify.mjs';

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
