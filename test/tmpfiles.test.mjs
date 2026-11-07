import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Exercise the installed rule's source with the real cleaner in a disposable root.
// mtime-only aging lets utimes represent old entries without waiting for their ctime to age.
test('tmpfiles preserves every protected prefix, including arbitrary .ICE names', t => {
  const root = mkdtempSync(join(tmpdir(), 'ap-tmpfiles-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tmp = join(root, 'tmp');
  mkdirSync(tmp);
  const rules = readFileSync(new URL('../scripts/autopilot-tmp.conf', import.meta.url), 'utf8');
  const config = join(root, 'rules.conf');
  writeFileSync(config, `e /tmp - - - mM:1d\n${rules}`);
  const protectedNames = ['systemd-private-live', '.X-test', '.ICE-test', 'tmux-live', 'claude-live', 'org.chromium.live'];
  const old = new Date(Date.now() - 3 * 86400e3);
  for (const name of [...protectedNames, 'old']) {
    const path = join(tmp, name);
    mkdirSync(path);
    writeFileSync(join(path, 'payload'), 'keep');
    utimesSync(join(path, 'payload'), old, old);
    utimesSync(path, old, old);
  }
  writeFileSync(join(tmp, 'fresh'), 'fresh');
  execFileSync('systemd-tmpfiles', ['--root', root, '--clean', '--prefix=/tmp', config], { encoding: 'utf8' });
  assert.equal(existsSync(join(tmp, 'old')), false, 'old control must be removed');
  assert.ok(existsSync(join(tmp, 'fresh')));
  for (const name of protectedNames) assert.ok(existsSync(join(tmp, name, 'payload')), `${name} must be preserved`);
});
