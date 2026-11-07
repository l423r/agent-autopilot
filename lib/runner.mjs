// Runs one autopilot iteration: a fresh `claude -p` or `codex exec` on one task, with a timeout and a log file.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pidRecord, livePid } from './pidfile.mjs';
import { codexModelFor } from './models.mjs';
import { runTmpDir, RUN_TMP_BASE } from './tmpclean.mjs';

const OUTPUT_TAIL_BYTES = 64 * 1024;
const KILL_GRACE_MS = 10_000;

export function buildPrompt(template, task, cfg) {
  const values = { taskId: task.id, taskTitle: task.title, planPath: cfg.planPath, progressPath: cfg.progressPath };
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) => values[key] ?? m);
}

// executor 'codex' runs `codex exec --json` with the mark's model from cfg.codexModels. Each process gets
// only its own account variable: codex no CLAUDE_CONFIG_DIR, claude no CODEX_HOME, even if the daemon has one.
export function runIteration({ task, cfg, stateDir, logDir, executor = 'claude', claudeBin = 'claude', codexBin = 'codex', timeoutMs, env = {}, prompt = '', model = null, onOutput = () => {} }) {
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const log = createWriteStream(join(logDir, `iter-${stamp}-${task.id.replace(/\s+/g, '')}.log`));
  const pidFile = join(stateDir, 'child.pid');

  const codex = executor === 'codex';
  const args = codex ? codexArgs(cfg, prompt, codexModelFor(model, cfg)) : [
    '-p', prompt,
    '--permission-mode', 'dontAsk',
    '--settings', join(cfg.autopilotDir, 'claude-settings.json'),
    '--output-format', 'json',
    ...(model ? ['--model', model] : []),
  ];
  const tmpDir = runTmpDir(cfg.tmpBase ?? RUN_TMP_BASE, stamp, task.id);
  let child;
  try {
    child = spawn(codex ? codexBin : claudeBin, args, {
      cwd: cfg.projectDir,
      env: { ...process.env, ...env, [codex ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: undefined, TMPDIR: tmpDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group, so a timeout kills everything claude started
    });
  } catch (err) {
    rmSync(tmpDir, { recursive: true, force: true });
    log.end();
    throw err;
  }
  let pidWritten = false;
  let setupError = null;

  let output = '';
  const collect = chunk => {
    log.write(chunk);
    output = (output + chunk.toString()).slice(-OUTPUT_TAIL_BYTES);
    onOutput();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child.pid, 'SIGTERM');
    setTimeout(() => killGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS).unref();
  }, timeoutMs);

  return new Promise((resolve, reject) => {
    const finish = exitCode => {
      clearTimeout(timer);
      try {
        rmSync(tmpDir, { recursive: true, force: true });
        if (pidWritten) rmSync(pidFile, { force: true });
        log.end(() => setupError ? reject(setupError) : resolve({ exitCode, output, timedOut }));
      } catch (err) {
        log.end(() => reject(err));
      }
    };
    child.on('error', err => {
      collect(Buffer.from(`spawn error: ${err.message}\n`));
    });
    child.on('close', code => finish(timedOut ? null : code));
    try {
      if (child.pid) {
        writeFileSync(pidFile, pidRecord(child.pid));
        pidWritten = true;
      }
    } catch (err) {
      setupError = err;
      killGroup(child.pid, 'SIGKILL');
      // Wait for close before removing TMPDIR, just as for a timeout.
    }
  });
}

function codexArgs(cfg, prompt, m) {
  return [
    'exec', '--json',
    '-C', cfg.projectDir,
    '--dangerously-bypass-approvals-and-sandbox',
    ...(m ? ['-m', m.model] : []),
    ...(m?.effort ? ['-c', `model_reasoning_effort="${m.effort}"`] : []),
    '--', prompt, // after `--`, so a prompt starting with «-» is not read as a flag
  ];
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
