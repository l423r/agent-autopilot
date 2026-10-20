// Pure decision logic: given the saved state and the current plan, what should the daemon do next,
// and how does the result of a run change the state.
import { nextTask, allDone } from './plan.mjs';

const STOPPED = ['paused', 'waiting-user', 'halted', 'auth', 'done'];

export function initialState() {
  return { status: 'idle', currentTask: null, attempts: {}, nextAttemptAt: null, reason: null, updatedAt: null };
}

export function decide(state, plan, now, cfg) {
  if (STOPPED.includes(state.status)) {
    return { action: 'stop', status: state.status, reason: state.reason ?? state.status };
  }
  if (state.status === 'sleeping' && state.nextAttemptAt && now < new Date(state.nextAttemptAt)) {
    return { action: 'sleep', until: new Date(state.nextAttemptAt) };
  }
  if (allDone(plan)) return { action: 'stop', status: 'done', reason: 'Все задачи плана выполнены' };

  const task = nextTask(plan);
  if (task.manual) return { action: 'stop', status: 'waiting-user', reason: `Ручная задача: ${task.title}` };

  const attempts = state.attempts[task.id] ?? 0;
  if (attempts >= cfg.maxAttempts) {
    return { action: 'stop', status: 'halted', reason: `${task.id} не удалась ${attempts} раз подряд` };
  }
  return { action: 'run', task };
}

export function applyResult(state, task, result, planAfter, now, cfg) {
  const base = { ...state, currentTask: task.id, nextAttemptAt: null, reason: null, updatedAt: now.toISOString() };
  const finished = planAfter.tasks.find(t => t.id === task.id)?.done;

  if (finished) {
    const { [task.id]: _, ...attempts } = state.attempts;
    const pause = cfg.pauseAfterPhase && task.lastInPhase;
    return { ...base, attempts, status: pause ? 'paused' : 'idle', reason: pause ? `Этап завершён: ${task.phase ?? task.id}` : null };
  }
  if (result.kind === 'limit') {
    const until = result.resetAt ?? new Date(now.getTime() + cfg.retryMinutes * 60_000);
    return { ...base, status: 'sleeping', nextAttemptAt: until.toISOString(), reason: 'Лимит исчерпан' };
  }
  if (result.kind === 'auth') {
    return { ...base, status: 'auth', reason: 'Claude не авторизован: войдите заново (claude, затем /login)' };
  }
  return {
    ...base,
    status: 'idle',
    attempts: { ...state.attempts, [task.id]: (state.attempts[task.id] ?? 0) + 1 },
    reason: `Попытка не удалась (${result.kind})`,
  };
}

export function resume(state) {
  if (!STOPPED.includes(state.status)) return state;
  return { ...state, status: 'idle', attempts: {}, reason: null, nextAttemptAt: null };
}
