// Parses a superpowers-style plan: "### Task N: title" headings with "- [ ]" step checkboxes,
// grouped under optional "## Этап ..." phase headings.

const TASK_RE = /^###\s+Task\s+(\d+)\s*:\s*(.*?)\s*$/;
const PHASE_RE = /^##\s+(Этап\s+[^.:\s]+)/;
const ANY_H2_RE = /^##\s/;
const BOX_RE = /^\s*[-*]\s+\[( |x|X)\]/;
const FENCE_RE = /^\s*(```|~~~)/;
const MODEL_RE = /\s*[·|]\s*model:\s*(haiku|sonnet|opus)\s*$/i;
const MANUAL_RE = /\s*\[manual\]\s*/i;
const PLANNER_RE = /\s*\[planner\]\s*/i;
// The autopilot cannot restart itself; "agent-autopilot-web" etc. are different units.
const SELF_RESTART_RE = /systemctl\s+restart\b[^\n]*\bagent-autopilot(?![-\w])/i;

export function parsePlan(markdown) {
  const tasks = [];
  const warnings = [];
  let phase = null;
  let current = null;
  let inFence = false;

  for (const line of markdown.split(/\r?\n/)) {
    if (current && current.kind === 'planner' && SELF_RESTART_RE.test(line)) {
      current.kind = 'user';
      warnings.push(`${current.id}: [planner] с рестартом agent-autopilot — задача переведена в [manual]`);
    }
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const task = line.match(TASK_RE);
    if (task) {
      // "· model: x" may sit on either side of "[manual]", so strip it before and after.
      let title = task[2];
      let model = null;
      const takeModel = () => {
        const m = title.match(MODEL_RE);
        if (m) {
          model = m[1].toLowerCase();
          title = title.slice(0, m.index);
        }
      };
      takeModel();
      const manual = MANUAL_RE.test(title);
      const planner = !manual && PLANNER_RE.test(title);
      title = title.replace(MANUAL_RE, ' ').replace(PLANNER_RE, ' ').trim();
      if (!model) takeModel();
      current = {
        id: `Task ${task[1]}`,
        title: title.trim(),
        model,
        phase,
        kind: manual ? 'user' : planner ? 'planner' : 'auto',
        boxes: 0,
        checked: 0,
      };
      tasks.push(current);
      continue;
    }
    if (ANY_H2_RE.test(line)) {
      const ph = line.match(PHASE_RE);
      phase = ph ? ph[1] : null;
      current = null;
      continue;
    }
    const box = current && line.match(BOX_RE);
    if (box) {
      current.boxes += 1;
      if (box[1] !== ' ') current.checked += 1;
    }
  }

  return {
    tasks: tasks.map((t, i) => ({
      id: t.id,
      title: t.title,
      model: t.model,
      phase: t.phase,
      kind: t.kind,
      manual: t.kind === 'user',
      boxes: t.boxes,
      checked: t.checked,
      done: t.checked === t.boxes,
      lastInPhase: i === tasks.length - 1 || tasks[i + 1].phase !== t.phase,
    })),
    warnings,
  };
}

export function nextTask(plan) {
  return plan.tasks.find(t => !t.done) ?? null;
}

export function allDone(plan) {
  return plan.tasks.every(t => t.done);
}
