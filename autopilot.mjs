#!/usr/bin/env node
// Autopilot CLI: run | once | status | resume | stats | queue
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parsePlan, nextTask, allDone } from './lib/plan.mjs';
import { classify, usageOf } from './lib/classify.mjs';
import { decide, applyResult, resume, markRunning, STOPPED } from './lib/decide.mjs';
import { pidRecord, livePid } from './lib/pidfile.mjs';
import { loadState, saveState } from './lib/state.mjs';
import { buildPrompt, runIteration, killOrphan } from './lib/runner.mjs';
import { notify, stopMessage, buttonsFor, waitingMessage, planDoneMessage, planMissingMessage, switchedMessage } from './lib/notify.mjs';
import { parseCommand, applyCommand, statusText } from './lib/commands.mjs';
import { subscribeCommands } from './lib/listen.mjs';
import { modelFor, validateModelConfig } from './lib/models.mjs';
import { appendRun, runsFile, summarizeRuns, statsText } from './lib/runs.mjs';
import { effectiveConfig, takeSwitch, applySwitch, queueSwitch, progressPathFor, projectByDir } from './lib/projects.mjs';
import { loadQueue, saveQueue, enqueue, removeAt, moveUp, pickNext, shouldPreempt, samePlan } from './lib/queue.mjs';
import { listAccounts, accountEnv } from './lib/accounts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = 'agent-autopilot';
const MAX_SLEEP_CHUNK_MS = 60_000;
const COMMAND_TICK_MS = 1000;

// Phone commands (ntfyCommands). The listener only queues commands and answers right away when
// nothing can change (status, unknown words, anything while busy); state.json is written by the
// main loop alone, between iterations. `pause` during an iteration sets pauseAfterTask, mirrored
// in state/pause-after-task so that an acknowledged pause survives a crash of the daemon.
const commands = { enabled: false, queue: [], busy: false, pauseAfterTask: false, lastPauseAt: 0 };

const pauseFile = cfg => join(cfg.stateDir, 'pause-after-task');
function setPauseAfterTask(cfg, on) {
  commands.pauseAfterTask = on;
  if (on) writeFileSync(pauseFile(cfg), new Date().toISOString() + '\n');
  else rmSync(pauseFile(cfg), { force: true });
}

function loadConfig() {
  const path = process.env.AUTOPILOT_CONFIG ?? join(HERE, 'config.json');
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  cfg.autopilotDir ??= HERE;
  cfg.stateDir ??= join(cfg.autopilotDir, 'state');
  cfg.logDir ??= join(cfg.autopilotDir, 'logs');
  validateModelConfig(cfg);
  listAccounts(cfg);
  return effectiveConfig(cfg);
}

const readPlan = cfg => parsePlan(readFileSync(resolve(cfg.projectDir, cfg.planPath), 'utf8'));
const readProgress = cfg => { try { return readFileSync(resolve(cfg.projectDir, cfg.progressPath), 'utf8'); } catch { return ''; } };

// [planner] tasks run with the planner's chat role plus the rules for running a task alone.
function promptTemplate(task) {
  if (task.kind !== 'planner') return readFileSync(join(HERE, 'prompt.md'), 'utf8');
  return readFileSync(join(HERE, 'web', 'planner-prompt.md'), 'utf8') + readFileSync(join(HERE, 'planner-task-prompt.md'), 'utf8');
}

// «НУЖЕН ЧЕЛОВЕК: …» written to the project log by this run (lines added after `before`).
function needHumanNote(before, after, task) {
  const added = after.startsWith(before) ? after.slice(before.length) : after;
  const line = added.split('\n').filter(l => l.includes(`${task.id}:`) && l.includes('НУЖЕН ЧЕЛОВЕК')).at(-1);
  return line ? line.slice(line.indexOf('НУЖЕН ЧЕЛОВЕК')).trim() : null;
}

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

const shortTime = iso => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// Env of the claude process for the chosen account. With several accounts the primary runs without
// CLAUDE_CONFIG_DIR even if the daemon has one; nothing else (git push) gets the account env.
function claudeEnv(cfg, name) {
  if (!name) return {};
  return { CLAUDE_CONFIG_DIR: undefined, ...accountEnv(listAccounts(cfg).find(a => a.name === name)) };
}

// One log line and one notification per account switch.
async function announceAccount(cfg, title, message) {
  logEvent(cfg, message);
  await send(cfg, { title, message, tags: 'twisted_rightwards_arrows', priority: 3 });
}

function withProgress(cfg, text) {
  try {
    const plan = readPlan(cfg);
    return `${text}\nПрогресс: ${plan.tasks.filter(t => t.done).length}/${plan.tasks.length}`;
  } catch {
    return text;
  }
}

// Plan warnings (e.g. a [planner] task turned [manual]) — once per daemon run.
const loggedWarnings = new Set();
function logWarnings(cfg, plan) {
  for (const w of plan.warnings ?? []) {
    const key = `${cfg.projectDir}|${cfg.planPath}|${w}`;
    if (loggedWarnings.has(key)) continue;
    loggedWarnings.add(key);
    logEvent(cfg, `предупреждение: ${basename(cfg.planPath)} — ${w}`);
  }
}

// One decision + its action. Returns 'continue' | 'stop' | { sleepUntil: Date }.
async function step(cfg) {
  const now = new Date();
  const state = loadState(cfg.stateDir);
  let plan;
  try {
    plan = readPlan(cfg);
  } catch (err) {
    // With a queue, followQueue has already dropped the missing plan and set waiting-user or done.
    if (!existsSync(queueFile(cfg))) throw err;
    logEvent(cfg, `план не читается: ${err.message}`);
    return 'stop';
  }
  logWarnings(cfg, plan);
  const d = decide(state, plan, now, cfg);

  if (d.action === 'stop') {
    if (state.status !== d.status || state.reason !== d.reason) {
      const waitingTask = d.status === 'waiting-user' ? waitingTaskOf(plan) : undefined;
      saveState(cfg.stateDir, { ...state, status: d.status, reason: d.reason, ...(waitingTask !== undefined && { waitingTask }), updatedAt: now.toISOString() });
      // A status set by applyResult (auth, paused) was already announced when it was saved.
      if (state.status !== d.status) await send(cfg, { ...stopMessage(d.status, withProgress(cfg, d.reason)), actions: buttonsFor(d.status) });
    }
    logEvent(cfg, `${d.status}: ${d.reason}`);
    return 'stop';
  }
  if (d.action === 'sleep') return { sleepUntil: d.until };

  const pre = d.account ? { ...state, account: d.account } : state;
  if (d.switched === 'back') await announceAccount(cfg, 'Автопилот: основная учётка', `Вернулся на «${d.account}»`);
  // Computed before markRunning counts this run; a run lost to a restart was already counted.
  const attempt = (state.attempts[d.task.id] ?? 0) + 1;
  const model = modelFor(d.task, attempt, cfg);
  logEvent(cfg, `run ${d.task.id}${model ? ` (${model}, попытка ${attempt})` : ''}: ${d.task.title}`);
  saveState(cfg.stateDir, markRunning(pre, d.task, now, model));
  commands.busy = true;
  const template = promptTemplate(d.task);
  const progressBefore = readProgress(cfg);
  const raw = await runIteration({
    task: d.task, cfg, stateDir: cfg.stateDir, logDir: cfg.logDir,
    claudeBin: process.env.AUTOPILOT_CLAUDE ?? 'claude',
    timeoutMs: cfg.iterationTimeoutMinutes * 60_000,
    prompt: buildPrompt(template, d.task, cfg),
    model,
    env: claudeEnv(cfg, d.account),
  });
  const finishedAt = new Date();
  const result = classify(raw, finishedAt, cfg);
  const note = needHumanNote(progressBefore, readProgress(cfg), d.task);
  let planAfter;
  try {
    planAfter = readPlan(cfg);
  } catch (err) {
    logEvent(cfg, `план не читается после ${d.task.id}: ${err.message}`);
    planAfter = { tasks: [] };
  }
  let next = applyResult(pre, d.task, { ...(result.kind === 'ok' && !planAfter.tasks.length ? { kind: 'error' } : result), note }, planAfter, finishedAt, cfg);
  const pauseNow = commands.pauseAfterTask && !STOPPED.includes(next.status);
  if (pauseNow) next = { ...next, status: 'paused', nextAttemptAt: null, reason: 'Пауза по команде с телефона' };
  saveState(cfg.stateDir, next);
  setPauseAfterTask(cfg, false);
  commands.busy = false;
  logEvent(cfg, `${d.task.id} → ${result.kind}; status ${next.status}${next.nextAttemptAt ? ` until ${next.nextAttemptAt}` : ''}${next.reason ? ` (${next.reason})` : ''}`);
  const finished = planAfter.tasks.find(t => t.id === d.task.id)?.done;
  try {
    appendRun(cfg.logDir, {
      at: finishedAt.toISOString(),
      project: projectByDir(cfg, cfg.projectDir)?.name ?? basename(cfg.projectDir),
      plan: basename(cfg.planPath),
      task: d.task.id, title: d.task.title, model, attempt,
      result: result.kind, done: Boolean(finished),
      durationSec: Math.round((finishedAt - now) / 1000),
      ...usageOf(raw.output ?? ''),
    });
  } catch (err) {
    logEvent(cfg, `runs.jsonl не записан: ${err.message}`);
  }
  if (cfg.pushAfterTask && finished) pushProject(cfg, d.task);
  if (finished && cfg.notifyEachTask) {
    await send(cfg, { title: `${d.task.id} готова`, message: withProgress(cfg, `${d.task.title}${model ? ` · ${model}` : ''}`), tags: 'heavy_check_mark', priority: 2, actions: buttonsFor('task') });
  }
  if (d.account && result.kind === 'limit' && next.account !== pre.account) {
    await announceAccount(cfg, 'Автопилот: запасная учётка', `Лимит «${pre.account}» до ${shortTime(next.accountLimits[pre.account])}, продолжаю на «${next.account}»`);
  }
  if (d.account && result.kind === 'auth' && next.status !== 'auth') {
    const go = next.account !== pre.account ? `, продолжаю на «${next.account}»` : `, жду сброса лимита до ${shortTime(next.nextAttemptAt)}`;
    await announceAccount(cfg, 'Автопилот: запасная учётка не авторизована', `Запасная учётка не авторизована: «${pre.account}»${go}`);
  }
  if (next.status === 'sleeping' && result.kind === 'limit') {
    const at = shortTime(next.nextAttemptAt);
    await send(cfg, { title: 'Автопилот: лимит Claude', message: `Продолжу ${at} (${d.task.id})`, tags: 'hourglass', priority: 3, actions: buttonsFor('limit') });
  }
  if (pauseNow) await send(cfg, { title: 'Автопилот на паузе', message: withProgress(cfg, `После ${d.task.id}`), tags: 'pause_button', priority: 3, actions: buttonsFor('paused') });
  else if (STOPPED.includes(next.status)) await send(cfg, { ...stopMessage(next.status, withProgress(cfg, next.reason)), actions: buttonsFor(next.status) });
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

function summary(cfg) {
  const s = loadState(cfg.stateDir);
  try {
    return statusText(s, readPlan(cfg));
  } catch (err) {
    return `Статус: ${s.status}\nПлан не читается: ${err.message}`;
  }
}

async function reply(cfg, r) {
  logEvent(cfg, `команда: ответ «${r.message.split('\n')[0]}»`);
  await send(cfg, r);
}

// Listener side: never writes state.json. Commands that may change the state wait in the queue.
async function onCommand(cfg, { message }) {
  const cmd = parseCommand(message);
  logEvent(cfg, `команда с телефона: ${cmd ?? 'неизвестная'}`);
  if (cmd === 'pause') commands.lastPauseAt = Date.now();
  if (!commands.busy && (cmd === 'pause' || cmd === 'resume')) {
    commands.queue.push(cmd);
    return;
  }
  const r = applyCommand(cmd, loadState(cfg.stateDir), { busy: commands.busy, summary: summary(cfg), pausePending: commands.pauseAfterTask });
  if (r.pauseAfterTask) setPauseAfterTask(cfg, true);
  if (r.cancelPause) setPauseAfterTask(cfg, false);
  await reply(cfg, r.reply);
}

// Main-loop side: applies queued commands between iterations.
async function drainCommands(cfg) {
  while (commands.queue.length) {
    const cmd = commands.queue.shift();
    const s = loadState(cfg.stateDir);
    const r = applyCommand(cmd, s, { busy: false, summary: summary(cfg) });
    if (r.state) {
      saveState(cfg.stateDir, { ...r.state, updatedAt: new Date().toISOString() });
      logEvent(cfg, `${cmd} по команде (было: ${s.status})`);
    }
    setPauseAfterTask(cfg, false);
    await reply(cfg, r.reply);
  }
}

// A plan switch requested by the panel (<stateDir>/switch.json). Taken only here, between
// iterations, so a running task always finishes on the plan it started on.
async function applyPendingSwitch(cfg) {
  let requestedAt;
  try { requestedAt = statSync(join(cfg.stateDir, 'switch.json')).mtimeMs; } catch { return; }
  const t = takeSwitch(cfg.stateDir);
  if (!t) return;
  const project = projectByDir(cfg, t.projectDir);
  const label = planLabel(cfg, t);
  // switch.json may be written by hand: a missing plan must not become a crash loop via active.json.
  if (!existsSync(resolve(t.projectDir, t.planPath))) {
    logEvent(cfg, `Переключение отклонено: нет плана ${resolve(t.projectDir, t.planPath)}`);
    await send(cfg, { title: 'Автопилот: план не найден', message: `Не переключено: нет файла ${t.planPath} (${label})`, tags: 'warning', priority: 3 });
    return;
  }
  const target = { projectDir: t.projectDir, planPath: t.planPath, progressPath: t.progressPath ?? progressPathFor(project ?? {}, t.planPath) };
  const was = basename(cfg.planPath);
  // A pause sent after the switch request wins: the plan changes, the autopilot stays paused.
  const keepPaused = loadState(cfg.stateDir).status === 'paused' && commands.lastPauseAt > requestedAt;
  queueSwitch(cfg.stateDir, target);
  applySwitch(cfg.stateDir, target, currentTarget(cfg), cfg.maxAttempts);
  if (keepPaused) saveState(cfg.stateDir, { ...loadState(cfg.stateDir), status: 'paused', reason: 'Пауза по команде с телефона' });
  Object.assign(cfg, target);
  setPauseAfterTask(cfg, false);
  logEvent(cfg, `Переключено: ${label} (было: ${was})${keepPaused ? ', на паузе' : ''}`);
  await send(cfg, { title: 'Автопилот: другой план', message: withProgress(cfg, `Переключено: ${label}${keepPaused ? '\nНа паузе — нажми «Продолжить»' : ''}`), tags: 'twisted_rightwards_arrows', priority: 3 });
}

// --- Plan queue (<stateDir>/queue.json). Without the file everything works as before. ---

const currentTarget = cfg => ({ projectDir: cfg.projectDir, planPath: cfg.planPath, progressPath: cfg.progressPath });
const sameTarget = samePlan;
const readTarget = t => parsePlan(readFileSync(resolve(t.projectDir, t.planPath), 'utf8'));
const planLabel = (cfg, t) => `${projectByDir(cfg, t.projectDir)?.name ?? basename(t.projectDir)} / ${basename(t.planPath)}`;
const queueFile = cfg => join(cfg.stateDir, 'queue.json');
const recheckMs = cfg => (cfg.queueRecheckSeconds ?? 60) * 1000;
let lastQueueError = null;

// Between tasks: the queue may move the daemon to another plan. Only from idle (preemption by
// a plan above the current one), done and waiting-user; paused, sleeping, halted, auth stay put.
async function switchTo(cfg, target, why) {
  const t = { projectDir: target.projectDir, planPath: target.planPath, progressPath: target.progressPath ?? progressPathFor(projectByDir(cfg, target.projectDir) ?? {}, target.planPath) };
  const was = basename(cfg.planPath);
  applySwitch(cfg.stateDir, t, currentTarget(cfg), cfg.maxAttempts);
  Object.assign(cfg, t);
  logEvent(cfg, `Переключено: ${planLabel(cfg, t)} (было: ${was})${why ? ` — ${why}` : ''}`);
  await send(cfg, switchedMessage(planLabel(cfg, t), why));
}

async function followQueue(cfg) {
  if (!existsSync(queueFile(cfg))) return;
  const q = loadQueue(cfg.stateDir);
  if (q.error) {
    if (q.error !== lastQueueError) logEvent(cfg, `очередь не читается, работаю без неё: ${q.error}`);
    lastQueueError = q.error;
    return;
  }
  lastQueueError = null;
  const state = loadState(cfg.stateDir);
  if (!['idle', 'done', 'waiting-user'].includes(state.status)) return;

  const current = currentTarget(cfg);
  let currentPlan = null;
  try { currentPlan = readPlan(cfg); } catch { /* reported by step() */ }
  let items = q.items;
  // The active plan always has its place in the queue: at the end, so a plan the user removed
  // does not jump ahead of the others (a switch puts a plan first via switch.json instead).
  if (currentPlan && !allDone(currentPlan) && !items.some(x => sameTarget(x, current))) items = enqueue(items, current);
  if (!items.length) return;

  const pick = pickNext(items, { readPlan: readTarget });
  const gone = new Set([...pick.doneTargets, ...pick.missing.map(m => m.target)]);
  const waiting = new Map(pick.waiting.map(w => [w.target, w.task]));
  const fresh = [];
  const since = new Date().toISOString();
  items = items.filter(x => !gone.has(x)).map(x => {
    const task = waiting.get(x);
    if (!task) {
      const { waitingUser: _, ...rest } = x;
      return rest;
    }
    if (x.waitingUser?.task === task.id) return x;
    fresh.push({ target: x, task });
    return { ...x, waitingUser: { task: task.id, since } };
  });
  // Saved before the notifications go out: an edit by the panel or the CLI during a slow send is not overwritten.
  if (JSON.stringify(items) !== JSON.stringify(q.items)) saveQueue(cfg.stateDir, items);
  for (const t of pick.doneTargets) {
    logEvent(cfg, `План выполнен: ${planLabel(cfg, t)}`);
    await send(cfg, planDoneMessage(planLabel(cfg, t)));
  }
  for (const { target: t, error } of pick.missing) {
    logEvent(cfg, `План убран из очереди: ${planLabel(cfg, t)} — ${error}`);
    await send(cfg, planMissingMessage(planLabel(cfg, t), error));
  }
  for (const { target: t, task } of fresh) {
    logEvent(cfg, `Ждёт вас: ${planLabel(cfg, t)} — ${task.id}: ${task.title}`);
    await send(cfg, waitingMessage(planLabel(cfg, t), task));
  }

  const currentRunnable = Boolean(currentPlan) && !allDone(currentPlan) && nextTask(currentPlan).kind !== 'user';
  if (state.status === 'idle' && currentRunnable) {
    const up = shouldPreempt(items, current, { readPlan: readTarget });
    if (up) await switchTo(cfg, up, 'выше в очереди');
    return;
  }
  if (pick.target) {
    if (!sameTarget(pick.target, current)) {
      await switchTo(cfg, pick.target, currentPlan && !allDone(currentPlan) && !currentRunnable ? 'тот ждёт вас' : null);
    } else if (state.status !== 'idle') {
      saveState(cfg.stateDir, { ...state, status: 'idle', reason: null, updatedAt: new Date().toISOString() });
      logEvent(cfg, `Продолжаю: ${planLabel(cfg, current)} (было: ${state.status})`);
    }
    return;
  }
  const status = pick.waiting.length ? 'waiting-user' : 'done';
  const reason = pick.waiting.length
    ? `Ждёт вас: ${pick.waiting.map(w => `${planLabel(cfg, w.target)} — ${w.task.id}: ${w.task.title}`).join('; ')}`
    : 'Все планы очереди выполнены';
  if (state.status === status && state.reason === reason) return;
  saveState(cfg.stateDir, { ...state, status, reason, ...(status === 'waiting-user' && { waitingTask: currentPlan ? waitingTaskOf(currentPlan) : null }), updatedAt: new Date().toISOString() });
  // «Ждёт вас» went out per task above; «готово» once for the whole queue.
  if (status === 'done' && state.status !== 'done') await send(cfg, { ...stopMessage('done', reason), actions: buttonsFor('done') });
}

// The `user` task the plan stops on, or null (plan finished or runnable).
const waitingTaskOf = plan => (!allDone(plan) && nextTask(plan).kind === 'user' ? nextTask(plan).id : null);

// waiting-user: the user may have ticked the manual task of the current plan. If the plan no
// longer stops on that task, the daemon goes on as after `resume`. state.waitingTask is the task
// it waits for (null: waits for other plans of the queue; missing: state from an older daemon).
function recheckWaiting(cfg) {
  const state = loadState(cfg.stateDir);
  if (state.status !== 'waiting-user' || state.waitingTask === null) return;
  let plan;
  try { plan = readPlan(cfg); } catch { return; }
  const waiting = waitingTaskOf(plan);
  if (waiting === state.waitingTask) return;
  if (state.waitingTask === undefined && waiting) {
    saveState(cfg.stateDir, { ...state, waitingTask: waiting });
    return;
  }
  const ticked = state.waitingTask ?? plan.tasks.filter(t => t.kind === 'user' && t.done).at(-1)?.id ?? 'план';
  saveState(cfg.stateDir, { ...resume(state), waitingTask: null, updatedAt: new Date().toISOString() });
  logEvent(cfg, `Ручная задача отмечена: ${ticked}`);
}

// Sleeps until `until` (ms timestamp, Infinity = no deadline); with commands on, in steps
// of at most a second, returning early as soon as a command is queued or the status in
// state.json changes (e.g. `autopilot.mjs resume` from the shell) or a plan switch is requested.
// With queue.json or in waiting-user it also returns after queueRecheckSeconds (60 s) to look
// at waiting plans again.
async function waitUntil(cfg, until) {
  const statusNow = () => { try { return loadState(cfg.stateDir).status; } catch { return null; } };
  const from = statusNow();
  const recheck = existsSync(queueFile(cfg)) || from === 'waiting-user';
  const deadline = recheck ? Math.min(until, Date.now() + recheckMs(cfg)) : until;
  const ticking = commands.enabled || recheck;
  for (;;) {
    if (commands.queue.length) return;
    if (existsSync(join(cfg.stateDir, 'switch.json'))) return;
    if (ticking && statusNow() !== from) return;
    const left = deadline - Date.now();
    if (left <= 0) return;
    const chunk = ticking ? COMMAND_TICK_MS : MAX_SLEEP_CHUNK_MS;
    await new Promise(res => setTimeout(res, Math.min(left, chunk)));
    if (!ticking) return;
  }
}

async function runLoop(cfg, once) {
  if (!acquireLock(cfg)) return;
  await killOrphan(cfg.stateDir);
  if (!once && cfg.ntfyCommands && cfg.ntfyTopic) {
    commands.enabled = true;
    subscribeCommands(cfg, {
      sinceFile: join(cfg.stateDir, 'commands.since'),
      onMessage: msg => onCommand(cfg, msg),
      log: s => logEvent(cfg, s),
    });
    logEvent(cfg, `команды с телефона: слушаю ${cfg.ntfyTopic}-cmd`);
    if (existsSync(pauseFile(cfg))) {
      commands.queue.push('pause');
      logEvent(cfg, 'пауза по команде, принятая до перезапуска');
    }
  }
  for (;;) {
    await applyPendingSwitch(cfg);
    await drainCommands(cfg);
    recheckWaiting(cfg);
    await followQueue(cfg);
    const r = await step(cfg);
    if (r === 'stop') {
      // A queue with plans waiting for the user keeps the daemon up to see their ticks.
      const waitsForUser = existsSync(queueFile(cfg)) && loadState(cfg.stateDir).status === 'waiting-user';
      if (once || (!commands.enabled && !waitsForUser)) return;
      await waitUntil(cfg, Infinity);
      continue;
    }
    if (r !== 'continue') {
      if (once) {
        console.log(`Следующая попытка: ${r.sleepUntil.toISOString()}`);
        return;
      }
      await waitUntil(cfg, Math.max(r.sleepUntil.getTime(), Date.now() + 1000));
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
    ...accountLines(cfg, s),
    ...queueBlocks(cfg),
  ].join('\n'));
}

// «Учётка» and the limits not reset yet; nothing without cfg.accounts.
function accountLines(cfg, s) {
  const accounts = listAccounts(cfg);
  if (accounts.length < 2) return [];
  const now = new Date();
  const limits = Object.entries(s.accountLimits ?? {}).filter(([, t]) => new Date(t) > now);
  return [`Учётка: ${s.account ?? accounts[0].name}`, ...limits.map(([name, t]) => `Лимит: ${name} до ${shortTime(t)}`)];
}

// --- `queue list|add|remove|up` and the queue blocks of `status` ---

// One row per queue entry: { target, done, total, waiting: task|null, error? }.
function queueRows(cfg, items) {
  return items.map(target => {
    try {
      const plan = readTarget(target);
      const next = allDone(plan) ? null : nextTask(plan);
      return { target, done: plan.tasks.filter(t => t.done).length, total: plan.tasks.length, waiting: next?.kind === 'user' ? next : null };
    } catch (err) {
      return { target, error: err.code === 'ENOENT' ? 'нет файла плана' : err.message };
    }
  });
}

const rowLine = (cfg, row, n) => `${n + 1}. ${planLabel(cfg, row.target)} — ${row.error ? `ошибка: ${row.error}` : `${row.done}/${row.total}${row.waiting ? `, ждёт вас: ${row.waiting.id}` : ''}`}`;

function queueBlocks(cfg) {
  const q = loadQueue(cfg.stateDir);
  if (q.error) return [`Очередь: не читается (${q.error})`];
  if (!q.items.length) return [];
  const rows = queueRows(cfg, q.items);
  const waiting = rows.filter(r => r.waiting);
  return [
    'Очередь:', ...rows.map((r, n) => rowLine(cfg, r, n)),
    ...(waiting.length ? ['Ждёт вас:', ...waiting.map(r => `${planLabel(cfg, r.target)} — ${r.waiting.id}: ${r.waiting.title}`)] : []),
  ];
}

function queueCommand(cfg, args) {
  const [sub, ...rest] = args;
  const fail = msg => { console.error(msg); process.exitCode = 2; };
  const q = loadQueue(cfg.stateDir);
  if (q.error) return fail(`Очередь не читается: ${q.error}`);
  if (sub === 'list') {
    console.log(q.items.length ? queueRows(cfg, q.items).map((r, n) => rowLine(cfg, r, n)).join('\n') : 'Очередь пуста');
  } else if (sub === 'add') {
    if (rest.length < 2) return fail('Использование: autopilot.mjs queue add <projectDir> <planPath>');
    const projectDir = resolve(rest[0]);
    const planPath = rest[1];
    if (!existsSync(resolve(projectDir, planPath))) return fail(`нет плана: ${resolve(projectDir, planPath)}`);
    const progressPath = progressPathFor(projectByDir(cfg, projectDir) ?? {}, planPath);
    saveQueue(cfg.stateDir, enqueue(q.items, { projectDir, planPath, progressPath }));
    console.log(`Добавлено: ${planLabel(cfg, { projectDir, planPath })}`);
  } else if (sub === 'remove' || sub === 'up') {
    const n = Number(rest[0]);
    if (!Number.isInteger(n)) return fail(`Нужен номер записи: autopilot.mjs queue ${sub} <n>`);
    if (n < 1 || n > q.items.length) return fail(`нет записи ${n} (в очереди ${q.items.length})`);
    saveQueue(cfg.stateDir, sub === 'remove' ? removeAt(q.items, n - 1) : moveUp(q.items, n - 1));
    console.log(sub === 'remove' ? `Убрано: ${n}` : `Поднято: ${n}`);
  } else {
    fail('Использование: autopilot.mjs queue list | add <projectDir> <planPath> | remove <n> | up <n>');
  }
}

function stats(cfg, args) {
  const i = args.indexOf('--plan');
  const plan = i === -1 ? null : basename(args[i + 1] ?? '');
  let lines = [];
  try { lines = readFileSync(runsFile(cfg.logDir), 'utf8').split('\n'); } catch { /* no runs yet */ }
  if (plan) lines = lines.filter(l => { try { return JSON.parse(l).plan === plan; } catch { return true; } });
  console.log(statsText(summarizeRuns(lines)));
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
else if (cmd === 'stats') stats(cfg, process.argv.slice(3));
else if (cmd === 'queue') queueCommand(cfg, process.argv.slice(3));
else {
  console.log('Использование: autopilot.mjs run | once | status | resume | stats [--plan <файл плана>] | queue list|add|remove|up');
  process.exitCode = 2;
}
