// Persists the daemon state as state.json (atomic write: temp file + rename).
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { initialState } from './decide.mjs';

export function loadState(dir) {
  try {
    return { ...initialState(), ...JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) };
  } catch (err) {
    if (err.code === 'ENOENT') return initialState();
    throw err;
  }
}

export function saveState(dir, state) {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.state.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, join(dir, 'state.json'));
}
