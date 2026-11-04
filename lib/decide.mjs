// Pure decision logic: given the saved state and the current plan, what should the daemon do next,
// and how does the result of a run change the state.
import { nextTask, allDone } from './plan.mjs';
import { listAccounts, pickAccount } from './accounts.mjs';

const MAX_BACKOFF_MINUTES = 300;

export const STOPPED = ['paused', 'waiting-user', 'halted', 'auth', 'done'];

export function initialState() {
  return { status: 'idle', currentTask: null, attempts: {}, nextAttemptAt: null, reason: null, updatedAt: null };
}

export function decide(state, plan, now, cfg) {
  if (STOPPED.includes(state.status)) {
    return { action: 'stop', status: state.status, reason: state.reason ?? state.status };
  }
  if (allDone(plan)) return { action: 'stop', status: 'done', reason: 'Все задачи плана выполнены' };

  const task = nextTask(plan);
  if (task.manual) return { action: 'stop', status: 'waiting-user', reason: `Ручная задача: ${task.title}` };

  const attempts = state.attempts[task.id] ?? 0;
  if (attempts >= cfg.maxAttempts) {
    const note = state.lastNote ? `: ${state.lastNote}` : '';
    return { action: 'stop', status: 'halted', reason: `${task.id} не удалась ${attempts} раз подряд${note}` };
  }
  if (state.status === 'sleeping' && state.nextAttemptAt && now < new Date(state.nextAttemptAt)) {
    return { action: 'sleep', until: new Date(state.nextAttemptAt) };
  }
  const accounts = listAccounts(cfg);
  if (accounts.length < 2) return { action: 'run', task };
  // Before every run: the first free account by priority, so the primary is taken back once its limit is over.
  const pick = pickAccount(accounts, state, now);
  if (!pick) return { action: 'sleep', until: nextReset(state, now) ?? new Date(now.getTime() + cfg.retryMinutes * 60_000) };
  return { action: 'run', task, account: pick.name, switched: pick.switched };
}

// The earliest account limit still ahead of now, or null.
function nextReset(state, now) {
  const ahead = Object.values(state.accountLimits ?? {}).map(t => new Date(t)).filter(t => t > now);
  return ahead.length ? new Date(Math.min(...ahead)) : null;
}

// With several accounts a limit (or auth on a spare) marks the current account and moves on to the
// next free one at once: status idle, the attempt is not counted. All out → sleeping until the earliest reset.
function moveAccount(base, state, accounts, mark, now, cfg, reason) {
  const next = { ...base, account: state.account ?? accounts[0].name, ...mark(state) };
  const pick = pickAccount(accounts, next, now);
  if (pick) return { ...next, account: pick.name, status: 'idle' };
  const until = nextReset(next, now) ?? new Date(now.getTime() + cfg.retryMinutes * 60_000);
  return { ...next, status: 'sleeping', nextAttemptAt: until.toISOString(), reason };
}

// Saved before claude starts: the attempt is already counted, so a daemon that dies mid-run
// cannot re-run the same task forever. applyResult works from the pre-run state.
export function markRunning(state, task, now, model = null) {
  return {
    ...state,
    status: 'running',
    currentTask: task.id,
    currentModel: model,
    attempts: { ...state.attempts, [task.id]: (state.attempts[task.id] ?? 0) + 1 },
    updatedAt: now.toISOString(),
  };
}

// result.note — why the run gave up, from the project log («НУЖЕН ЧЕЛОВЕК: …»); kept as
// lastNote until the task is finished, so the halted reason can name it.
export function applyResult(state, task, result, planAfter, now, cfg) {
  const base = { ...state, currentTask: task.id, nextAttemptAt: null, reason: null, updatedAt: now.toISOString() };
  if (result.note) base.lastNote = result.note;
  const finished = planAfter.tasks.find(t => t.id === task.id)?.done;

  const accounts = listAccounts(cfg);
  const current = accounts.find(a => a.name === state.account) ?? accounts[0];
  // A run that ended other than by a limit: the account works again, its doubled limit mark is forgotten.
  if (result.kind !== 'limit' && state.accountBackoff?.[current.name] !== undefined) {
    const { [current.name]: _, ...backoff } = state.accountBackoff;
    base.accountBackoff = backoff;
  }

  if (finished) {
    const { [task.id]: _, ...attempts } = state.attempts;
    const pause = cfg.pauseAfterPhase && task.lastInPhase;
    return { ...base, attempts, lastNote: null, status: pause ? 'paused' : 'idle', reason: pause ? `Этап завершён: ${task.phase ?? task.id}` : null };
  }
  if (result.kind === 'limit') {
    const until = result.resetAt ?? new Date(now.getTime() + cfg.retryMinutes * 60_000);
    if (accounts.length > 1) {
      // No reset time in the message: each repeated limit doubles the mark (up to 5 h), so a still-limited
      // account is not taken back and lost again on every task.
      const { [current.name]: prev, ...backoff } = state.accountBackoff ?? {};
      const minutes = result.resetAt ? null : prev ? Math.min(prev * 2, MAX_BACKOFF_MINUTES) : cfg.retryMinutes;
      const markUntil = minutes ? new Date(now.getTime() + minutes * 60_000) : until;
      const mark = s => ({
        accountLimits: { ...s.accountLimits, [current.name]: markUntil.toISOString() },
        ...((minutes || state.accountBackoff) && { accountBackoff: minutes ? { ...backoff, [current.name]: minutes } : backoff }),
      });
      return moveAccount(base, state, accounts, mark, now, cfg, 'Лимит исчерпан');
    }
    return { ...base, status: 'sleeping', nextAttemptAt: until.toISOString(), reason: 'Лимит исчерпан' };
  }
  if (result.kind === 'auth') {
    if (current !== accounts[0]) {
      const mark = s => ({ accountAuth: [...new Set([...(s.accountAuth ?? []), current.name])] });
      return moveAccount(base, state, accounts, mark, now, cfg, `Учётка «${current.name}» не авторизована`);
    }
    return { ...base, status: 'auth', reason: 'Claude не авторизован: войдите заново (claude, затем /login)' };
  }
  return {
    ...base,
    status: 'sleeping',
    nextAttemptAt: new Date(now.getTime() + cfg.retryMinutes * 60_000).toISOString(),
    attempts: { ...state.attempts, [task.id]: (state.attempts[task.id] ?? 0) + 1 },
    reason: `Попытка не удалась (${result.kind})`,
  };
}

// Account limits not reset yet are kept; the auth marks are dropped (the user may have logged in).
export function resume(state) {
  const { accountAuth: _, ...rest } = state;
  if (!STOPPED.includes(state.status)) return 'accountAuth' in state ? rest : state;
  return { ...rest, status: 'idle', attempts: {}, reason: null, nextAttemptAt: null, lastNote: null };
}
