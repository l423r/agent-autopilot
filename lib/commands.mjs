// Phone commands: a fixed whitelist of words, never passed on to a shell or to Claude.
// applyCommand is pure: the main loop saves the state it returns, so the listener never writes state.json.
import { STOPPED, resume } from './decide.mjs';
import { nextTask, parsePlan, planTitle } from './plan.mjs';
import { nowView } from './now.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { effectiveConfig, projectByDir } from './projects.mjs';
import { loadQueue, samePlan } from './queue.mjs';

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
      const { accountAuth: _, ...rest } = state;
      return { ...none, state: { ...rest, status: 'idle', nextAttemptAt: null, reason: null }, reply: reply('Продолжаю работу, не дожидаясь паузы') };
    }
    if (busy && pausePending) return { ...none, cancelPause: true, reply: reply('Пауза отменена, продолжаю работу') };
    return { ...none, reply: reply('Я уже работаю') };
  }

  return { ...none, reply: reply('Неизвестная команда. Доступны: статус, пауза, продолжить') };
}

// Enrich state/queue for both CLI and HTTP readers. The active plan also works without queue.json.
export function nowContext(cfg, state, now = new Date()) {
  const active = effectiveConfig(cfg);
  const row = target => {
    const current = samePlan(target, active);
    const base = {
      project: projectByDir(active, target.projectDir)?.name ?? basename(target.projectDir),
      planTitle: basename(target.planPath, '.md'), active: current, next: null, waiting: null,
    };
    try {
      const markdown = readFileSync(resolve(target.projectDir, target.planPath), 'utf8');
      const next = nextTask(parsePlan(markdown));
      return { ...base, planTitle: planTitle(markdown, target.planPath), next, waiting: next?.kind === 'user' ? next : null };
    } catch { return base; }
  };
  const current = row(active);
  const queue = existsSync(join(cfg.stateDir, 'queue.json'))
    ? loadQueue(cfg.stateDir).items.map(row)
    : current.next ? [current] : [];
  // Sleeping resumes the active plan even if it was removed from the queue during the wait.
  if (state.status === 'sleeping' && current.next && !queue.some(r => r.active)) queue.push(current);
  return { state: { ...state, planTitle: current.planTitle }, queue, now };
}

export function statusText(state, plan, { queue = [], now = new Date() } = {}) {
  const current = nowView({ state, queue, now });
  const done = plan.tasks.filter(t => t.done).length;
  const next = nextTask(plan);
  const task = state.status === 'running' && state.currentTask
    ? `Текущая задача: ${state.currentTask}${state.currentModel ? ` (${state.currentModel})` : ''}`
    : `Следующая задача: ${next ? `${next.id}: ${next.title}` : '—'}`;
  return [
    current.title, ...current.details,
    `Статус: ${state.status}${state.reason ? ` — ${state.reason}` : ''}`,
    `Прогресс: ${done}/${plan.tasks.length}`,
    task,
    ...(state.nextAttemptAt ? [`Следующая попытка: ${state.nextAttemptAt}`] : []),
  ].join('\n');
}
