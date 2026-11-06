// Which model mark runs a task: the task's mark (or opus for [planner], or cfg.defaultModel), one step up the
// ladder per failed attempt, never above the top.
export const MODELS = ['haiku', 'sonnet', 'opus'];

// attempt — number of the run about to start, from 1.
export function modelFor(task, attempt, cfg) {
  const base = task.model ?? (task.kind === 'planner' ? 'opus' : cfg.defaultModel) ?? null;
  if (!base) return null;
  const step = MODELS.indexOf(base) + Math.max(attempt - 1, 0);
  return MODELS[Math.min(step, MODELS.length - 1)];
}

export const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

// The Codex model and reasoning effort for a mark, from cfg.codexModels; null → codex runs its own default.
export function codexModelFor(model, cfg) {
  return (model && cfg.codexModels?.[model]) || null;
}

export function validateModelConfig(cfg) {
  if (cfg.defaultModel !== undefined && !MODELS.includes(cfg.defaultModel)) {
    throw new Error(`defaultModel: допустимо ${MODELS.join(', ')}`);
  }
  for (const [mark, m] of Object.entries(cfg.codexModels ?? {})) {
    if (!MODELS.includes(mark)) throw new Error(`codexModels: ключи — ${MODELS.join(', ')}`);
    if (typeof m?.model !== 'string' || !m.model.trim()) throw new Error(`codexModels.${mark}: нет model`);
    if (m.effort !== undefined && !CODEX_EFFORTS.includes(m.effort)) throw new Error(`codexModels.${mark}: effort — ${CODEX_EFFORTS.join(', ')}`);
  }
}
