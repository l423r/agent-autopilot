import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchLimits } from '../web/limits.mjs';
import { startServer } from '../web/server.mjs';

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
afterEach(async () => { await srv?.close(); srv = null; });

test('/api/limits: cached for 60 s — two requests, one fetch', async () => {
  const fetchImpl = fakeFetch(200, USAGE);
  const cfg = { projectDir: root, planPath: 'plan.md', autopilotDir: root, stateDir: join(root, 'state') };
  srv = await startServer(cfg, { port: 0, limitsFetch: () => fetchLimits({ credentialsFile, fetchImpl }) });
  const base = `http://127.0.0.1:${srv.port}`;
  const first = await (await fetch(`${base}/api/limits`)).json();
  const second = await (await fetch(`${base}/api/limits`)).json();
  assert.deepEqual(first.fiveHour, { percent: 11, resetsAt: '2026-10-21T18:20:00Z' });
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
  assert.equal(typeof body.error, 'string');
  assert.ok(!JSON.stringify(body).includes(TOKEN));
  assert.equal((await fetch(`${base}/api/history`)).status, 200);
});
