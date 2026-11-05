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

// One pass over the lines; each task keeps the line indices of its step boxes so that
// tickStep numbers steps exactly as parsePlan counts them.
function scan(markdown) {
  const tasks = [];
  const warnings = [];
  let phase = null;
  let current = null;
  let inFence = false;

  const lines = markdown.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
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
      // Marks count only outside `...` spans: odd split segments are code and stay as text.
      const outside = (fn) => title.split(/(`[^`]*`)/).map((seg, i) => (i % 2 ? seg : fn(seg)));
      const manual = outside(s => MANUAL_RE.test(s)).some(r => r === true);
      const planner = !manual && outside(s => PLANNER_RE.test(s)).some(r => r === true);
      title = title.split(/(`[^`]*`)/)
        .map((seg, i) => (i % 2 ? seg : seg.replace(MANUAL_RE, ' ').replace(PLANNER_RE, ' ')))
        .join('').trim();
      if (!model) takeModel();
      current = {
        id: `Task ${task[1]}`,
        title: title.trim(),
        model,
        phase,
        kind: manual ? 'user' : planner ? 'planner' : 'auto',
        boxes: 0,
        checked: 0,
        boxLines: [],
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
      current.boxLines.push(li);
      if (box[1] !== ' ') current.checked += 1;
    }
  }
  return { tasks, warnings };
}

export function parsePlan(markdown) {
  const { tasks, warnings } = scan(markdown);
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

// Ticks step `step` (1-based, numbered as parsePlan counts boxes) of a [manual] task.
// Only "[ ]" -> "[x]" in that line changes; line endings and all other bytes stay as they were.
export function tickStep(markdown, taskId, step) {
  const task = scan(markdown).tasks.find(t => t.id === taskId);
  if (!task) return { error: 'no-task' };
  if (task.kind !== 'user') return { error: 'not-manual' };
  if (!Number.isInteger(step) || step < 1 || step > task.boxes) return { error: 'no-step' };
  // Odd parts are the line separators, so line i is parts[2 * i].
  const parts = markdown.split(/(\r?\n)/);
  const at = 2 * task.boxLines[step - 1];
  const box = parts[at].match(BOX_RE);
  if (box[1] !== ' ') return { error: 'already' };
  parts[at] = parts[at].replace(/^(\s*[-*]\s+\[) \]/, '$1x]');
  return { markdown: parts.join(''), taskDone: task.checked + 1 === task.boxes };
}

// Steps of a task as the panel shows them: n is the same number tickStep takes.
export function taskSteps(markdown, taskId) {
  const task = scan(markdown).tasks.find(t => t.id === taskId);
  if (!task) return [];
  const lines = markdown.split(/\r?\n/);
  return task.boxLines.map((li, i) => {
    const m = lines[li].match(/^\s*[-*]\s+\[( |x|X)\]\s*(.*)$/);
    return { n: i + 1, text: m[2].trim(), done: m[1] !== ' ' };
  });
}

// Each task's own text: from its heading up to the next task or phase heading (same cut as the panel).
const TASK_HEAD = /^#{2,4}\s+Task\s+(\d+)\b/;
export function taskBodies(markdown) {
  const bodies = new Map();
  let id = null;
  let lines = [];
  const flush = () => { if (id) bodies.set(id, lines.join('\n').trim()); };
  for (const line of markdown.split(/\r?\n/)) {
    const m = line.match(TASK_HEAD);
    if (m) { flush(); id = `Task ${m[1]}`; lines = []; continue; }
    if (/^#{1,2}\s/.test(line) || /^---\s*$/.test(line)) { flush(); id = null; lines = []; continue; }
    if (id) lines.push(line);
  }
  flush();
  return bodies;
}

export function nextTask(plan) {
  return plan.tasks.find(t => !t.done) ?? null;
}

export function allDone(plan) {
  return plan.tasks.every(t => t.done);
}
