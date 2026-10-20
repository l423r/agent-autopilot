import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState } from '../lib/state.mjs';

test('missing file → idle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ap-'));
  const s = loadState(dir);
  assert.equal(s.status, 'idle');
  assert.deepEqual(s.attempts, {});
});

test('state roundtrip leaves no temp files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ap-'));
  const s = { status: 'sleeping', currentTask: 'Task 2', attempts: { 'Task 2': 1 }, nextAttemptAt: '2026-10-20T15:00:00.000Z', reason: null, updatedAt: '2026-10-20T12:00:00.000Z' };
  saveState(dir, s);
  assert.deepEqual(loadState(dir), s);
  assert.deepEqual(readdirSync(dir), ['state.json']);
});
