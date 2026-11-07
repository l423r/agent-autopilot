import { mkdirSync, lstatSync, readdirSync, rmSync, statfsSync } from 'node:fs';
import { join } from 'node:path';

export const RUN_TMP_BASE = '/var/tmp/autopilot';
const DAY_MS = 24 * 3600e3;
const protectedName = name => /^(systemd-private-|\.X|\.ICE|tmux-|claude-|org\.chromium\.)/.test(name);

// Inspect without following links. A fresh or protected descendant also protects its parent.
function removableBytes(path, name, cutoff) {
  const stat = lstatSync(path);
  // utimes/stat can lose a microsecond; round conservatively at the age boundary.
  if (protectedName(name) || stat.isSocket() || Math.ceil(stat.mtimeMs) >= cutoff) return null;
  let bytes = stat.blocks * 512;
  if (stat.isDirectory()) {
    for (const child of readdirSync(path)) {
      const size = removableBytes(join(path, child), child, cutoff);
      if (size === null) return null;
      bytes += size;
    }
  }
  return bytes;
}

export function cleanTmp({ dir = '/tmp', threshold = .7, minAgeMs = 12 * 3600e3, now = Date.now(), statfs = statfsSync, log = () => {} } = {}) {
  const result = { removed: 0, freedBytes: 0, skipped: 0 };
  let names;
  try {
    const { blocks, bfree } = statfs(dir);
    if (!blocks || (blocks - bfree) / blocks <= threshold) return result;
    names = readdirSync(dir);
  } catch {
    result.skipped++;
    return result;
  }
  for (const name of names) {
    try {
      const path = join(dir, name);
      const bytes = removableBytes(path, name, Number(now) - minAgeMs);
      if (bytes === null) { result.skipped++; continue; }
      rmSync(path, { recursive: true });
      result.removed++;
      result.freedBytes += bytes;
    } catch {
      // One inaccessible or disappearing entry must not prevent the next task.
      result.skipped++;
    }
  }
  if (result.removed) log(`очистка /tmp: удалено ${result.removed} записей, освобождено ${(result.freedBytes / 1024 ** 2).toFixed(2)} МБ`);
  return result;
}

export function runTmpDir(base = RUN_TMP_BASE, stamp, taskId) {
  const safe = value => String(value).replace(/[^a-zA-Z0-9_.-]/g, '_');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const dir = join(base, `${safe(stamp)}-${safe(taskId)}`);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

export function removeStale(base = RUN_TMP_BASE, maxAgeMs = DAY_MS) {
  let names;
  try { names = readdirSync(base); } catch { return; }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of names) {
    try {
      const path = join(base, name);
      const stat = lstatSync(path);
      if (stat.isDirectory() && stat.mtimeMs < cutoff) rmSync(path, { recursive: true });
    } catch { /* Leave inaccessible entries for the next startup. */ }
  }
}
