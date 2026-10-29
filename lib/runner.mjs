// Runs one autopilot iteration: a fresh `claude -p` on one task, with a timeout and a log file.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pidRecord, livePid } from './pidfile.mjs';

const OUTPUT_TAIL_BYTES = 64 * 1024;
const KILL_GRACE_MS = 10_000;

export function buildPrompt(template, task, cfg) {
  const values = { taskId: task.id, taskTitle: task.title, planPath: cfg.planPath, progressPath: cfg.progressPath };
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) => values[key] ?? m);
}

export function runIteration({ task, cfg, stateDir, logDir, claudeBin = 'claude', timeoutMs, env = {}, prompt = '', model = null }) {
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const log = createWriteStream(join(logDir, `iter-${stamp}-${task.id.replace(/\s+/g, '')}.log`));
  const pidFile = join(stateDir, 'child.pid');

  const args = [
    '-p', prompt,
    '--permission-mode', 'dontAsk',
    '--settings', join(cfg.autopilotDir, 'claude-settings.json'),
    '--output-format', 'json',
    ...(model ? ['--model', model] : []),
  ];
  const child = spawn(claudeBin, args, {
    cwd: cfg.projectDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group, so a timeout kills everything claude started
  });
  if (child.pid) writeFileSync(pidFile, pidRecord(child.pid));

  let output = '';
  const collect = chunk => {
    log.write(chunk);
    output = (output + chunk.toString()).slice(-OUTPUT_TAIL_BYTES);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child.pid, 'SIGTERM');
    setTimeout(() => killGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS).unref();
  }, timeoutMs);

  return new Promise(resolve => {
    const finish = exitCode => {
      clearTimeout(timer);
      rmSync(pidFile, { force: true });
      log.end(() => resolve({ exitCode, output, timedOut }));
    };
    child.on('error', err => {
      collect(Buffer.from(`spawn error: ${err.message}\n`));
      finish(null);
    });
    child.on('close', code => finish(timedOut ? null : code));
  });
}

// A daemon restarted mid-iteration may leave its claude child running; kill it before starting anew.
export async function killOrphan(stateDir) {
  const pidFile = join(stateDir, 'child.pid');
  const pid = livePid(pidFile);
  if (pid) {
    killGroup(pid, 'SIGTERM');
    const deadline = Date.now() + KILL_GRACE_MS;
    while (isAlive(pid) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    if (isAlive(pid)) killGroup(pid, 'SIGKILL');
  }
  rmSync(pidFile, { force: true });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}
