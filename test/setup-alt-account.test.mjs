import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, lstatSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('../scripts/setup-alt-account.sh', import.meta.url).pathname;
const LINKS = ['settings.json', 'plugins', 'skills', 'projects'];

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'alt-acc-'));
  const src = join(root, 'src');
  const dst = join(root, 'dst');
  mkdirSync(src);
  writeFileSync(join(src, 'settings.json'), '{}');
  for (const d of ['plugins', 'skills', 'projects']) mkdirSync(join(src, d));
  writeFileSync(join(src, '.credentials.json'), 'PRIMARY-FAKE');
  return { src, dst };
}
const run = (src, dst) => spawnSync('bash', [SCRIPT], { env: { ...process.env, SRC: src, DST: dst }, encoding: 'utf8' });

test('creates symlinks to SRC and leaves credentials alone', () => {
  const { src, dst } = setup();
  const r = run(src, dst);
  assert.equal(r.status, 0, r.stderr);
  for (const n of LINKS) {
    assert.ok(lstatSync(join(dst, n)).isSymbolicLink(), n);
    assert.equal(readlinkSync(join(dst, n)), join(src, n));
  }
  assert.ok(!existsSync(join(dst, '.credentials.json')));
  assert.equal(readFileSync(join(src, '.credentials.json'), 'utf8'), 'PRIMARY-FAKE');
});

test('does not touch an existing DST credentials file', () => {
  const { src, dst } = setup();
  mkdirSync(dst);
  writeFileSync(join(dst, '.credentials.json'), 'ALT-FAKE');
  assert.equal(run(src, dst).status, 0);
  assert.equal(readFileSync(join(dst, '.credentials.json'), 'utf8'), 'ALT-FAKE');
});

test('second run is safe and adds nothing', () => {
  const { src, dst } = setup();
  assert.equal(run(src, dst).status, 0);
  const before = readdirSync(dst).sort();
  const r = run(src, dst);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(dst).sort(), before);
  assert.equal(readlinkSync(join(dst, 'plugins')), join(src, 'plugins'));
});

test('existing non-symlink in DST is not overwritten: clear error', () => {
  const { src, dst } = setup();
  mkdirSync(join(dst, 'skills'), { recursive: true });
  writeFileSync(join(dst, 'skills', 'keep.txt'), 'mine');
  writeFileSync(join(dst, 'settings.json'), 'own');
  const r = run(src, dst);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /skills|settings\.json/);
  assert.match(r.stderr, /не симлинк/);
  assert.equal(readFileSync(join(dst, 'settings.json'), 'utf8'), 'own');
  assert.equal(readFileSync(join(dst, 'skills', 'keep.txt'), 'utf8'), 'mine');
});
