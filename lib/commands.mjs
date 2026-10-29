// Phone commands: a fixed whitelist of words, never passed on to a shell or to Claude.
// applyCommand is pure: the main loop saves the state it returns, so the listener never writes state.json.
import { STOPPED, resume } from './decide.mjs';
import { nextTask } from './plan.mjs';

const WORDS = {
  status: ['статус', 'status', '?'],
  pause: ['пауза', 'pause', 'стоп', 'stop'],
  resume: ['продолжить', 'resume', 'дальше', 'go'],
};
const MAX_LEN = 32;

export function parseCommand(text) {
  if (typeof text !== 'string' || text.length > MAX_LEN) return null;
  const word = text.trim().toLowerCase();
  for (const [cmd, words] of Object.entries(WORDS)) if (words.includes(word)) return cmd;
  return null;
}

const reply = message => ({ title: 'Автопилот', message });

export function applyCommand(cmd, state, { busy, summary, pausePending = false }) {
  const none = { state: null, pauseAfterTask: false, cancelPause: false };
  if (cmd === 'status') return { ...none, reply: reply(summary) };

  if (cmd === 'pause') {
    if (STOPPED.includes(state.status)) return { ...none, reply: reply(`Автопилот уже остановлен (${state.status})`) };
    if (busy) {
      return { ...none, pauseAfterTask: true, reply: reply(`Пауза после текущей задачи: ${state.currentTask ?? '—'}`) };
    }
    return {
      ...none,
      state: { ...state, status: 'paused', nextAttemptAt: null, reason: 'Пауза по команде с телефона' },
      reply: reply('Автопилот на паузе'),
    };
  }

  if (cmd === 'resume') {
    if (STOPPED.includes(state.status)) return { ...none, state: resume(state), reply: reply('Продолжаю работу') };
    if (!busy && state.status === 'sleeping') {
      return { ...none, state: { ...state, status: 'idle', nextAttemptAt: null, reason: null }, reply: reply('Продолжаю работу, не дожидаясь паузы') };
    }
    if (busy && pausePending) return { ...none, cancelPause: true, reply: reply('Пауза отменена, продолжаю работу') };
    return { ...none, reply: reply('Я уже работаю') };
  }

  return { ...none, reply: reply('Неизвестная команда. Доступны: статус, пауза, продолжить') };
}

export function statusText(state, plan) {
  const done = plan.tasks.filter(t => t.done).length;
  const next = nextTask(plan);
  const task = state.status === 'running' && state.currentTask
    ? `Текущая задача: ${state.currentTask}${state.currentModel ? ` (${state.currentModel})` : ''}`
    : `Следующая задача: ${next ? `${next.id}: ${next.title}` : '—'}`;
  return [
    `Статус: ${state.status}${state.reason ? ` — ${state.reason}` : ''}`,
    `Прогресс: ${done}/${plan.tasks.length}`,
    task,
    ...(state.nextAttemptAt ? [`Следующая попытка: ${state.nextAttemptAt}`] : []),
  ].join('\n');
}
