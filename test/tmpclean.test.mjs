import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync, chmodSync, symlinkSync, readFileSync, lutimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { cleanTmp, runTmpDir, removeStale } from '../lib/tmpclean.mjs';

const now = Date.now();
const old = new Date(now - 13 * 3600e3);
const full = () => ({ blocks: 100, bfree: 25, bsize: 4096 });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ap-clean-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function file(dir, name, at = old) {
  const path = join(dir, name);
  writeFileSync(path, 'temporary');
  utimesSync(path, at, at);
  return path;
}

test('75%: removes old top-level entries, preserves exclusions, fresh files and sockets', async t => {
  const dir = fixture(t);
  const excluded = ['systemd-private-abc', '.X11-unix', '.ICE-unix', 'tmux-1000', 'claude-profile', 'org.chromium.profile'];
  for (const name of excluded) file(dir, name);
  file(dir, 'fresh', new Date(now));
  file(dir, 'boundary', new Date(now - 12 * 3600e3));
  file(dir, 'old');
  const nested = join(dir, 'old-dir');
  mkdirSync(nested);
  file(nested, 'child');
  utimesSync(nested, old, old);
  const socket = join(dir, 'active.sock');
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  utimesSync(socket, old, old);
  const logs = [];
  const result = cleanTmp({ dir, now, statfs: full, log: line => logs.push(line) });
  assert.equal(result.removed, 2);
  assert.ok(result.freedBytes >= 18);
  assert.equal(existsSync(join(dir, 'old')), false);
  assert.equal(existsSync(nested), false);
  for (const name of [...excluded, 'fresh', 'boundary', 'active.sock']) assert.ok(existsSync(join(dir, name)), name);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^очистка \/tmp: удалено 2 записей, освобождено [\d.]+ МБ$/);
});

test('60% and exactly 70%: no cleanup', t => {
  const dir = fixture(t);
  const path = file(dir, 'old');
  for (const bfree of [40, 30]) {
    const result = cleanTmp({ dir, now, statfs: () => ({ blocks: 100, bfree, bsize: 4096 }) });
    assert.equal(result.removed, 0);
    assert.equal(result.freedBytes, 0);
    assert.ok(existsSync(path));
  }
});

test('chmod 000: inaccessible entry is skipped, cleanup continues', t => {
  const dir = fixture(t);
  chmodSync(dir, 0o777);
  const blocked = join(dir, 'blocked');
  mkdirSync(join(blocked, 'nested'), { recursive: true });
  file(join(blocked, 'nested'), 'child');
  utimesSync(blocked, old, old);
  chmodSync(blocked, 0);
  const good = file(dir, 'removable');
  const source = new URL('../lib/tmpclean.mjs', import.meta.url);
  // Import from stdin: /root cannot be traversed by nobody.
  const script = `import { cleanTmp } from ${JSON.stringify(source.href)}; console.log(JSON.stringify(cleanTmp({dir:process.argv[1],now:Number(process.argv[2]),statfs:()=>({blocks:100,bfree:25,bsize:4096})})));`;
  const localModule = join(dir, 'tmpclean.mjs');
  writeFileSync(localModule, readFileSync(source));
  let output;
  try {
    output = execFileSync(process.execPath, ['--input-type=module', '-e', script.replace(source.href, new URL(`file://${localModule}`).href), dir, String(now)], {
      encoding: 'utf8', ...(process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {}),
    });
  } finally {
    chmodSync(blocked, 0o700);
  }
  const result = JSON.parse(output);
  assert.ok(result.skipped >= 1);
  assert.equal(result.removed, 1);
  assert.ok(existsSync(blocked));
  assert.equal(existsSync(good), false);
});

test('runTmpDir creates a private directory beneath base, sanitizing task ID', t => {
  const base = join(fixture(t), 'runs');
  const dir = runTmpDir(base, '2026-11-07', 'Task 1/../../outside');
  assert.equal(dir.startsWith(base + '/'), true);
  assert.equal(dir.slice(base.length + 1).includes('/'), false);
  assert.ok(existsSync(dir));
});

test('removeStale removes only directories older than one day without following symlinks', t => {
  const root = fixture(t);
  const base = join(root, 'runs');
  mkdirSync(base);
  const stale = runTmpDir(base, 'old', 'Task1');
  const fresh = runTmpDir(base, 'new', 'Task2');
  const yesterday = new Date(Date.now() - 25 * 3600e3);
  utimesSync(stale, yesterday, yesterday);
  const external = join(root, 'external');
  mkdirSync(external);
  file(external, 'keep');
  symlinkSync(external, join(base, 'link'));
  removeStale(base, 24 * 3600e3);
  assert.equal(existsSync(stale), false);
  assert.ok(existsSync(fresh));
  assert.ok(existsSync(join(external, 'keep')));
  assert.doesNotThrow(() => removeStale(join(root, 'absent'), 24 * 3600e3));
});

test('old parent containing fresh files, protected profiles or a socket is preserved', async t => {
  const dir = fixture(t);
  const names = ['fresh-container', 'chromium-container', 'claude-container', 'socket-container'];
  for (const name of names) mkdirSync(join(dir, name));
  file(join(dir, names[0]), 'fresh', new Date(now));
  file(join(dir, names[1]), 'org.chromium.profile');
  file(join(dir, names[2]), 'claude-profile');
  const socket = join(dir, names[3], 'live.sock');
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  utimesSync(socket, old, old);
  for (const name of names) utimesSync(join(dir, name), old, old);
  const external = fixture(t);
  const target = file(external, 'keep');
  const link = join(dir, 'old-link');
  symlinkSync(external, link);
  lutimesSync(link, old, old);
  const result = cleanTmp({ dir, now, statfs: full });
  assert.equal(result.removed, 1);
  for (const name of names) assert.ok(existsSync(join(dir, name)), name);
  assert.equal(existsSync(link), false);
  assert.ok(existsSync(target));
});

test('statfs or directory read failure is nonfatal', t => {
  const dir = fixture(t);
  assert.deepEqual(cleanTmp({ dir, statfs: () => { throw new Error('statfs unavailable'); } }), { removed: 0, freedBytes: 0, skipped: 1 });
  assert.deepEqual(cleanTmp({ dir: join(dir, 'missing'), statfs: full }), { removed: 0, freedBytes: 0, skipped: 1 });
});

test('daemon removes stale run dirs at startup and cleans tmp before each attempt', t => {
  const root = fixture(t);
  const tmp = join(root, 'tmp');
  const base = join(root, 'runs');
  mkdirSync(tmp);
  const stale = runTmpDir(base, 'stale', 'Task1');
  const fresh = runTmpDir(base, 'fresh', 'Task1');
  const yesterday = new Date(Date.now() - 25 * 3600e3);
  utimesSync(stale, yesterday, yesterday);
  const candidate = file(tmp, 'old');
  const cfg = {
    projectDir: root, autopilotDir: root, stateDir: join(root, 'state'), logDir: join(root, 'logs'),
    planPath: 'plan.md', progressPath: 'progress.md', tmpDir: tmp, tmpBase: base,
    maxAttempts: 2, retryMinutes: 0, iterationTimeoutMinutes: 1, limitPatterns: [], authPatterns: [],
  };
  writeFileSync(join(root, 'plan.md'), '### Task 1: one\n- [ ] step\n');
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify(cfg));
  // Patch only this subprocess's fixture filesystem usage; never clean the real /tmp.
  const preload = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const real = fs.statfsSync; fs.statfsSync = (dir, ...args) => dir === ${JSON.stringify(tmp)}
      ? {blocks:100,bfree:25,bsize:4096} : real(dir,...args); syncBuiltinESMExports();`;
  execFileSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, fileURLToPath(new URL('../autopilot.mjs', import.meta.url)), 'run'], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, AUTOPILOT_CONFIG: config, AUTOPILOT_CLAUDE: fileURLToPath(new URL('./fixtures/fake-tmp.mjs', import.meta.url)), FAKE_CLEAN_CANDIDATE: candidate, FAKE_TMP_ERROR: '1' },
  });
  assert.equal(existsSync(stale), false);
  assert.ok(existsSync(fresh));
  assert.deepEqual(readdirSync(base), ['fresh-Task1']);
  const log = readFileSync(join(cfg.logDir, 'autopilot.log'), 'utf8');
  assert.equal(log.match(/очистка \/tmp: удалено 1 записей/g)?.length, 2);
  assert.equal(JSON.parse(readFileSync(join(cfg.stateDir, 'state.json'), 'utf8')).status, 'halted');
});

test('12-hour boundary survives filesystem sub-millisecond rounding', t => {
  const dir = fixture(t);
  const boundary = Date.UTC(2026, 10, 7, 0, 0, 0, 1);
  const path = file(dir, 'boundary', new Date(boundary));
  const result = cleanTmp({ dir, now: boundary + 12 * 3600e3, statfs: full });
  assert.equal(result.removed, 0);
  assert.ok(existsSync(path));
});

test('dryRun lists only eligible candidates without deleting or logging removals', async t => {
  const dir = fixture(t);
  const excluded = ['systemd-private-live', '.X11-unix', '.ICE-unix', 'tmux-live', 'claude-live', 'org.chromium.live'];
  for (const name of excluded) file(dir, name);
  file(dir, 'fresh', new Date(now));
  file(dir, 'boundary', new Date(now - 12 * 3600e3));
  const candidate = file(dir, 'old');
  const nested = join(dir, 'nested');
  mkdirSync(nested);
  file(nested, 'claude-profile');
  utimesSync(nested, old, old);
  const socket = join(dir, 'live.sock');
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  utimesSync(socket, old, old);
  const before = readdirSync(dir).sort();
  const logs = [];
  const result = cleanTmp({ dir, now, statfs: full, dryRun: true, log: line => logs.push(line) });
  assert.ok(existsSync(candidate), 'dryRun must preserve the eligible file');
  assert.deepEqual(result.candidates, [candidate]);
  assert.equal(result.removed, 0);
  assert.equal(result.freedBytes, 0);
  assert.deepEqual(logs, []);
  assert.deepEqual(readdirSync(dir).sort(), before);
  assert.equal(readFileSync(candidate, 'utf8'), 'temporary');
  const low = cleanTmp({ dir, now, statfs: () => ({ blocks: 100, bfree: 40 }), dryRun: true });
  assert.deepEqual(low.candidates, []);
});
