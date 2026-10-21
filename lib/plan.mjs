// Parses a superpowers-style plan: "### Task N: title" headings with "- [ ]" step checkboxes,
// grouped under optional "## Этап ..." phase headings.

const TASK_RE = /^###\s+Task\s+(\d+)\s*:\s*(.*?)\s*$/;
const PHASE_RE = /^##\s+(Этап\s+[^.:\s]+)/;
const ANY_H2_RE = /^##\s/;
const BOX_RE = /^\s*[-*]\s+\[( |x|X)\]/;
const FENCE_RE = /^\s*(```|~~~)/;

export function parsePlan(markdown) {
  const tasks = [];
  let phase = null;
  let current = null;
  let inFence = false;

  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const task = line.match(TASK_RE);
    if (task) {
      current = {
        id: `Task ${task[1]}`,
        title: task[2].replace(/\s*\[manual\]\s*/i, ' ').trim(),
        phase,
        manual: /\[manual\]/i.test(task[2]),
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
      phase: t.phase,
      manual: t.manual,
      boxes: t.boxes,
      checked: t.checked,
      done: t.checked === t.boxes,
      lastInPhase: i === tasks.length - 1 || tasks[i + 1].phase !== t.phase,
    })),
  };
}

export function nextTask(plan) {
  return plan.tasks.find(t => !t.done) ?? null;
}

export function allDone(plan) {
  return plan.tasks.every(t => t.done);
}
