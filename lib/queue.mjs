// Plan queue: <stateDir>/queue.json = [{ projectDir, planPath, progressPath, addedAt, waitingUser? }]
// and the choice of the next plan. Pure list helpers return new arrays.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import { nextTask, allDone } from './plan.mjs';

const isItem = x => x && typeof x === 'object' && typeof x.projectDir === 'string' && typeof x.planPath === 'string';
// "/p/" and "/p", "./x.md" and "x.md" name the same plan.
export const samePlan = (a, b) => resolve(a.projectDir) === resolve(b.projectDir) && normalize(a.planPath) === normalize(b.planPath);

// A missing file is an empty queue; a broken one is too, with `error` for the log — never a throw.
export function loadQueue(stateDir) {
  const file = join(stateDir, 'queue.json');
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { items: [] };
    return { items: [], error: `${file}: ${err.message}` };
  }
  if (!Array.isArray(data)) return { items: [], error: `${file}: ожидался массив` };
  const items = data.filter(isItem);
  return items.length === data.length ? { items } : { items, error: `${file}: пропущено записей: ${data.length - items.length}` };
}

export function saveQueue(stateDir, items) {
  mkdirSync(stateDir, { recursive: true });
  const tmp = join(stateDir, `.queue.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(items, null, 2) + '\n');
  renameSync(tmp, join(stateDir, 'queue.json'));
}

// Adds the plan to the end, or first with `front`. A plan already queued keeps its entry (and addedAt).
export function enqueue(items, target, { front = false, now = new Date() } = {}) {
  const i = items.findIndex(x => samePlan(x, target));
  if (i >= 0 && !front) return [...items];
  const entry = i >= 0 ? items[i] : { projectDir: target.projectDir, planPath: target.planPath, progressPath: target.progressPath, addedAt: now.toISOString() };
  const rest = items.filter((_, j) => j !== i);
  return front ? [entry, ...rest] : [...rest, entry];
}

export function removeAt(items, n) {
  return items.filter((_, j) => j !== n);
}

export function moveUp(items, n) {
  const out = [...items];
  if (n > 0 && n < out.length) [out[n - 1], out[n]] = [out[n], out[n - 1]];
  return out;
}

// Reads the plan of a queue entry; a gone or unreadable file is { error } instead of a throw.
function look(target, readPlan) {
  try {
    const plan = readPlan(target);
    return plan ? { plan } : { error: `нет плана: ${target.planPath}` };
  } catch (err) {
    return { error: err.message };
  }
}

// First plan whose next task is not `user` and which is not finished. Every plan is read once,
// so `waiting` lists all user-waiting plans of the queue, not only those before the target.
export function pickNext(items, { readPlan }) {
  const out = { target: null, waiting: [], doneTargets: [], missing: [] };
  for (const target of items) {
    const { plan, error } = look(target, readPlan);
    if (error) out.missing.push({ target, error });
    else if (allDone(plan)) out.doneTargets.push(target);
    else if (nextTask(plan).kind === 'user') out.waiting.push({ target, task: nextTask(plan) });
    else out.target ??= target;
  }
  return out;
}

// A plan queued above `current` that can go on again (its next task is no longer `user`).
export function shouldPreempt(items, current, { readPlan }) {
  const at = current ? items.findIndex(x => samePlan(x, current)) : -1;
  for (const target of items.slice(0, Math.max(at, 0))) {
    const { plan } = look(target, readPlan);
    if (plan && !allDone(plan) && nextTask(plan).kind !== 'user') return target;
  }
  return null;
}
