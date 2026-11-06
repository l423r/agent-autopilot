import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// [planner] tasks run with the planner's chat role plus the rules for running a task alone (always Claude).
// An ordinary task gets prompt-codex.md for the codex executor, prompt.md otherwise.
export function promptTemplate(task, executor = 'claude') {
  if (task.kind === 'planner') return readFileSync(join(ROOT, 'web', 'planner-prompt.md'), 'utf8') + readFileSync(join(ROOT, 'planner-task-prompt.md'), 'utf8');
  return readFileSync(join(ROOT, executor === 'codex' ? 'prompt-codex.md' : 'prompt.md'), 'utf8');
}
