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
  const s = { status: 'sleeping', currentTask: 'Task 2', attempts: { 'Task 2': 1 }, nextAttemptAt: '2026-10-20T15:00:00.000Z', reason: null, updatedAt: '2026-10-20T12:00:00.000Z' };
  saveState(dir, s);
  assert.deepEqual(loadState(dir), s);
  assert.deepEqual(readdirSync(dir), ['state.json']);
});
