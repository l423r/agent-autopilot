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
    const stubborn = process.env.FAKE_TMP_STUBBORN;
    if (process.env.FAKE_TMP_GRACEFUL) process.on('SIGTERM', () => process.exit(0));
    const child = spawn(process.execPath, ['-e', stubborn
      ? 'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000)'
      : 'setInterval(() => {}, 1000)'], { stdio: stubborn ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'inherit' });
    if (stubborn) child.once('message', () => {
      console.log(JSON.stringify({ childPid: child.pid }));
      child.disconnect();
      if (process.env.FAKE_TMP_GROUP_SIGNAL) setTimeout(() => process.kill(-process.pid, 'SIGTERM'), 20);
    });
    else console.log(JSON.stringify({ childPid: child.pid }));
    setInterval(() => {}, 1000);
  } else if (process.env.FAKE_TMP_SIGNAL) {
    process.kill(-process.pid, 'SIGTERM');
  } else if (process.env.FAKE_TMP_ERROR) {
    process.exitCode = 1;
  }
}
