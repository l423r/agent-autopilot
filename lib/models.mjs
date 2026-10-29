// Which Claude model runs a task: the task's mark (or cfg.defaultModel), one step up the
// ladder per failed attempt, never above the top.
export const MODELS = ['haiku', 'sonnet', 'opus'];

// attempt — number of the run about to start, from 1.
export function modelFor(task, attempt, cfg) {
  const base = task.model ?? cfg.defaultModel ?? null;
  if (!base) return null;
  const step = MODELS.indexOf(base) + Math.max(attempt - 1, 0);
  return MODELS[Math.min(step, MODELS.length - 1)];
}

export function validateModelConfig(cfg) {
  if (cfg.defaultModel !== undefined && !MODELS.includes(cfg.defaultModel)) {
    throw new Error(`defaultModel: допустимо ${MODELS.join(', ')}`);
  }
}
