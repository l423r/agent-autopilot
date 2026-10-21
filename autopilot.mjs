#!/usr/bin/env node
// Autopilot CLI: run | once | status | resume
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parsePlan, nextTask } from './lib/plan.mjs';
import { classify } from './lib/classify.mjs';
import { decide, applyResult, resume, markRunning, STOPPED } from './lib/decide.mjs';
import { pidRecord, livePid } from './lib/pidfile.mjs';
import { loadState, saveState } from './lib/state.mjs';
import { buildPrompt, runIteration, killOrphan } from './lib/runner.mjs';
import { notify, stopMessage, buttonsFor } from './lib/notify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = 'agent-autopilot';
const MAX_SLEEP_CHUNK_MS = 60_000;

function loadConfig() {
  const path = process.env.AUTOPILOT_CONFIG ?? join(HERE, 'config.json');
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  cfg.autopilotDir ??= HERE;
  cfg.stateDir ??= join(cfg.autopilotDir, 'state');
  cfg.logDir ??= join(cfg.autopilotDir, 'logs');
  return cfg;
}

const readPlan = cfg => parsePlan(readFileSync(resolve(cfg.projectDir, cfg.planPath), 'utf8'));

function logEvent(cfg, message) {
  mkdirSync(cfg.logDir, { recursive: true });
  const line = `${new Date().toISOString()} ${message}`;
  appendFileSync(join(cfg.logDir, 'autopilot.log'), line + '\n');
  console.log(line);
}

// `git push` of the project's current branch to its upstream. A failure is only logged:
// the commits stay local and go out with the next successful push.
function pushProject(cfg, task) {
  const r = spawnSync('git', ['push'], { cwd: cfg.projectDir, encoding: 'utf8', timeout: 120_000 });
  const detail = `${r.stderr ?? ''}${r.error?.message ?? ''}`.trim().split('\n').at(-1);
  logEvent(cfg, r.status === 0 ? `push ${task.id}: ок` : `push ${task.id}: не удался — ${detail}`);
}

async function send(cfg, msg) {
  if (!cfg.ntfyTopic) return;
  const ok = await notify(cfg, { ...msg, title: `${basename(cfg.projectDir)} · ${msg.title}` });
  if (!ok) logEvent(cfg, `уведомление не отправлено: ${msg.title}`);
}

function withProgress(cfg, text) {
  try {
    const plan = readPlan(cfg);
    return `${text}\nПрогресс: ${plan.tasks.filter(t => t.done).length}/${plan.tasks.length}`;
  } catch {
    return text;
  }
}

// One decision + its action. Returns 'continue' | 'stop' | { sleepUntil: Date }.
async function step(cfg) {
  const now = new Date();
  const state = loadState(cfg.stateDir);
  const d = decide(state, readPlan(cfg), now, cfg);

  if (d.action === 'stop') {
    if (state.status !== d.status || state.reason !== d.reason) {
      saveState(cfg.stateDir, { ...state, status: d.status, reason: d.reason, updatedAt: now.toISOString() });
      // A status set by applyResult (auth, paused) was already announced when it was saved.
      if (state.status !== d.status) await send(cfg, { ...stopMessage(d.status, withProgress(cfg, d.reason)), actions: buttonsFor(d.status) });
    }
    logEvent(cfg, `${d.status}: ${d.reason}`);
    return 'stop';
  }
  if (d.action === 'sleep') return { sleepUntil: d.until };

  logEvent(cfg, `run ${d.task.id}: ${d.task.title}`);
  saveState(cfg.stateDir, markRunning(state, d.task, now));
  const template = readFileSync(join(HERE, 'prompt.md'), 'utf8');
  const raw = await runIteration({
    task: d.task, cfg, stateDir: cfg.stateDir, logDir: cfg.logDir,
    claudeBin: process.env.AUTOPILOT_CLAUDE ?? 'claude',
    timeoutMs: cfg.iterationTimeoutMinutes * 60_000,
    prompt: buildPrompt(template, d.task, cfg),
  });
  const finishedAt = new Date();
  const result = classify(raw, finishedAt, cfg);
  let planAfter;
  try {
    planAfter = readPlan(cfg);
  } catch (err) {
    logEvent(cfg, `план не читается после ${d.task.id}: ${err.message}`);
    planAfter = { tasks: [] };
  }
  const next = applyResult(state, d.task, result.kind === 'ok' && !planAfter.tasks.length ? { kind: 'error' } : result, planAfter, finishedAt, cfg);
  saveState(cfg.stateDir, next);
  logEvent(cfg, `${d.task.id} → ${result.kind}; status ${next.status}${next.nextAttemptAt ? ` until ${next.nextAttemptAt}` : ''}${next.reason ? ` (${next.reason})` : ''}`);
  const finished = planAfter.tasks.find(t => t.id === d.task.id)?.done;
  if (cfg.pushAfterTask && finished) pushProject(cfg, d.task);
  if (finished && cfg.notifyEachTask) {
    await send(cfg, { title: `${d.task.id} готова`, message: withProgress(cfg, d.task.title), tags: 'heavy_check_mark', priority: 2, actions: buttonsFor('task') });
  }
  if (next.status === 'sleeping' && result.kind === 'limit') {
    const at = new Date(next.nextAttemptAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    await send(cfg, { title: 'Автопилот: лимит Claude', message: `Продолжу ${at} (${d.task.id})`, tags: 'hourglass', priority: 3, actions: buttonsFor('limit') });
  }
  if (STOPPED.includes(next.status)) await send(cfg, { ...stopMessage(next.status, withProgress(cfg, next.reason)), actions: buttonsFor(next.status) });
  return 'continue';
}

function acquireLock(cfg) {
  mkdirSync(cfg.stateDir, { recursive: true });
  const lock = join(cfg.stateDir, 'daemon.lock');
  const holder = livePid(lock);
  if (holder && holder !== process.pid) {
    console.log(`Автопилот уже работает (pid ${holder})`);
    return false;
  }
  writeFileSync(lock, pidRecord(process.pid));
  const release = () => rmSync(lock, { force: true });
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await killOrphan(cfg.stateDir);
      process.exit(0);
    });
  }
  return true;
}

async function runLoop(cfg, once) {
  if (!acquireLock(cfg)) return;
  await killOrphan(cfg.stateDir);
  for (;;) {
    const r = await step(cfg);
    if (r === 'stop') return;
    if (r !== 'continue') {
      if (once) {
        console.log(`Следующая попытка: ${r.sleepUntil.toISOString()}`);
        return;
      }
      const ms = Math.min(r.sleepUntil.getTime() - Date.now(), MAX_SLEEP_CHUNK_MS);
      await new Promise(res => setTimeout(res, Math.max(ms, 1000)));
      continue;
    }
    if (once) return;
  }
}

function status(cfg) {
  const s = loadState(cfg.stateDir);
  const plan = readPlan(cfg);
  const done = plan.tasks.filter(t => t.done).length;
  const next = nextTask(plan);
  let apk = null;
  try {
    const lines = readFileSync(resolve(cfg.projectDir, cfg.progressPath), 'utf8').split('\n').filter(l => /^\s*APK:/.test(l));
    apk = lines.at(-1)?.trim() ?? null;
  } catch { /* no progress file yet */ }
  console.log([
    `Статус: ${s.status}`,
    `Прогресс: ${done}/${plan.tasks.length} задач`,
    `Текущая задача: ${s.currentTask ?? '—'}`,
    `Следующая по плану: ${next ? `${next.id}: ${next.title}${next.manual ? ' [manual]' : ''}` : '—'}`,
    `Следующая попытка: ${s.nextAttemptAt ?? '—'}`,
    `Причина: ${s.reason ?? '—'}`,
    apk ? `Последний ${apk}` : 'APK: ещё не собирался',
  ].join('\n'));
}

function doResume(cfg) {
  const s = loadState(cfg.stateDir);
  saveState(cfg.stateDir, { ...resume(s), updatedAt: new Date().toISOString() });
  logEvent(cfg, `resume (было: ${s.status})`);
  if (!process.env.AUTOPILOT_CONFIG) {
    const installed = spawnSync('systemctl', ['cat', SERVICE], { stdio: 'ignore' }).status === 0;
    if (installed) spawnSync('systemctl', ['start', SERVICE], { stdio: 'inherit' });
  }
}

const cmd = process.argv[2];
const cfg = loadConfig();
if (cmd === 'run') await runLoop(cfg, false);
else if (cmd === 'once') await runLoop(cfg, true);
else if (cmd === 'status') status(cfg);
else if (cmd === 'resume') doResume(cfg);
else {
  console.log('Использование: autopilot.mjs run | once | status | resume');
  process.exitCode = 2;
}
