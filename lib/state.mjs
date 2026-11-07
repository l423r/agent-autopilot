// Persists the daemon state as state.json (atomic write: temp file + rename).
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { initialState } from './decide.mjs';

export function loadState(dir) {
  try {
    return { heartbeatAt: null, run: null, ...initialState(), ...JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) };
  } catch (err) {
    if (err.code === 'ENOENT') return { ...initialState(), heartbeatAt: null, run: null };
    throw err;
  }
}

export function saveState(dir, state) {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.state.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, join(dir, 'state.json'));
}

// These updates read the latest file so timers do not overwrite status/command changes.
export function heartbeat(dir, now = new Date()) {
  saveState(dir, { ...loadState(dir), heartbeatAt: now.toISOString() });
}

export function recordOutput(dir, now = new Date()) {
  const state = loadState(dir);
  if (!state.run || +now - Date.parse(state.run.lastOutputAt) < 15_000) return;
  saveState(dir, { ...state, run: { ...state.run, lastOutputAt: now.toISOString() } });
}
