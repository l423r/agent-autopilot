import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState } from '../lib/state.mjs';

const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const tempDir = prefix => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d; };

test('missing file → idle', () => {
  const dir = tempDir('ap-');
  const s = loadState(dir);
  assert.equal(s.status, 'idle');
  assert.deepEqual(s.attempts, {});
});

test('state roundtrip leaves no temp files', () => {
  const dir = tempDir('ap-');
  const s = { heartbeatAt: null, run: null, status: 'sleeping', currentTask: 'Task 2', attempts: { 'Task 2': 1 }, nextAttemptAt: '2026-10-20T15:00:00.000Z', reason: null, updatedAt: '2026-10-20T12:00:00.000Z' };
  saveState(dir, s);
  assert.deepEqual(loadState(dir), s);
  assert.deepEqual(readdirSync(dir), ['state.json']);
});

test('legacy state without heartbeat/run remains readable', () => {
  const dir = tempDir('ap-legacy-');
  saveState(dir, { status: 'halted', attempts: { 'Task 2': 2 }, reason: 'old' });
  const s = loadState(dir);
  assert.equal(s.status, 'halted');
  assert.equal(s.reason, 'old');
  assert.equal(s.heartbeatAt, null);
  assert.equal(s.run, null);
});

test('heartbeat preserves every status and run; output timestamps are throttled at 15 seconds', async () => {
  const { heartbeat, recordOutput } = await import('../lib/state.mjs');
  const dir = tempDir('ap-heartbeat-');
  const start = new Date('2026-11-07T12:00:00Z');
  for (const status of ['idle', 'running', 'sleeping', 'halted', 'waiting-user', 'paused', 'done', 'auth']) {
    saveState(dir, { status, attempts: {}, run: { lastOutputAt: start.toISOString() } });
    heartbeat(dir, new Date(+start + 60_000));
    assert.equal(loadState(dir).heartbeatAt, new Date(+start + 60_000).toISOString());
    assert.equal(loadState(dir).status, status);
    assert.deepEqual(loadState(dir).run, { lastOutputAt: start.toISOString() });
  }
  recordOutput(dir, new Date(+start + 14_999));
  assert.equal(loadState(dir).run.lastOutputAt, start.toISOString());
  recordOutput(dir, new Date(+start + 15_000));
  assert.equal(loadState(dir).run.lastOutputAt, new Date(+start + 15_000).toISOString());
  recordOutput(dir, new Date(+start + 15_001));
  assert.equal(loadState(dir).run.lastOutputAt, new Date(+start + 15_000).toISOString());
  saveState(dir, { ...loadState(dir), run: null });
  recordOutput(dir, new Date(+start + 30_000));
  assert.equal(loadState(dir).run, null);
});
