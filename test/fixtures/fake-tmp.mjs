#!/usr/bin/env node
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// node --test also discovers this fixture; only executor invocations have arguments.
if (process.argv.length > 2) {
  const dir = mkdtempSync(join(tmpdir(), 'executor-'));
  writeFileSync(join(dir, 'payload'), 'temporary data');
  console.log(JSON.stringify({ tmp: tmpdir(), dir }));
  if (process.env.FAKE_CLEAN_CANDIDATE) {
    writeFileSync(process.env.FAKE_CLEAN_CANDIDATE, 'next cleanup');
    const old = new Date(Date.now() - 13 * 3600e3);
    utimesSync(process.env.FAKE_CLEAN_CANDIDATE, old, old);
  }
  if (process.env.FAKE_TMP_HANG) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    console.log(JSON.stringify({ childPid: child.pid }));
    setInterval(() => {}, 1000);
  } else if (process.env.FAKE_TMP_SIGNAL) {
    process.kill(-process.pid, 'SIGTERM');
  } else if (process.env.FAKE_TMP_ERROR) {
    process.exitCode = 1;
  }
}
