import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parsePlan } from '../lib/plan.mjs';
import { loadQueue, saveQueue, enqueue, removeAt, moveUp, pickNext, shouldPreempt } from '../lib/queue.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'ap-queue-'));
const item = name => ({ projectDir: `/p/${name}`, planPath: `docs/plans/${name}.md`, progressPath: `docs/plans/${name}.progress.md`, addedAt: '2026-11-01T10:00:00.000Z' });

const PLANS = {
  auto: parsePlan('### Task 1: a\n- [x] s\n### Task 2: b\n- [ ] s'),
  planner: parsePlan('### Task 1: [planner] Выкладка\n- [ ] s'),
  user: parsePlan('### Task 1: a\n- [x] s\n### Task 2: [manual] Включение\n- [ ] s'),
  done: parsePlan('### Task 1: a\n- [x] s'),
};
// readPlan stand-in: plan by item name; unknown name = the plan file is gone.
const reader = plans => target => {
  const name = target.planPath.match(/plans\/(.+)\.md$/)[1];
  if (!(name in plans)) throw Object.assign(new Error(`ENOENT: ${target.planPath}`), { code: 'ENOENT' });
  return plans[name];
};
const names = list => list.map(t => t.planPath.match(/plans\/(.+)\.md$/)[1]);

test('loadQueue: no file → empty queue, no error', () => {
  const dir = tmp();
  assert.deepEqual(loadQueue(dir), { items: [] });
  rmSync(dir, { recursive: true });
});

test('saveQueue then loadQueue round-trips; write is atomic (no temp files left)', () => {
  const dir = tmp();
  const items = [item('a'), item('b')];
  saveQueue(dir, items);
  assert.deepEqual(loadQueue(dir), { items });
  assert.deepEqual(readdirSync(dir), ['queue.json']);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'queue.json'), 'utf8')), items);
  rmSync(dir, { recursive: true });
});

test('saveQueue creates the state dir', () => {
  const dir = join(tmp(), 'nested');
  saveQueue(dir, [item('a')]);
  assert.equal(loadQueue(dir).items.length, 1);
});

test('loadQueue: broken file → empty items with error, no throw (Review Focus 4)', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'queue.json'), '[{"projectDir": ');
  const q = loadQueue(dir);
  assert.deepEqual(q.items, []);
  assert.match(q.error, /queue\.json/);
  writeFileSync(join(dir, 'queue.json'), '{"not":"an array"}');
  assert.match(loadQueue(dir).error, /queue\.json/);
  rmSync(dir, { recursive: true });
});

test('loadQueue: drops malformed entries with an error, keeps valid ones', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'queue.json'), JSON.stringify([item('a'), { planPath: 7 }, null]));
  const q = loadQueue(dir);
  assert.deepEqual(q.items, [item('a')]);
  assert.match(q.error, /queue\.json/);
  rmSync(dir, { recursive: true });
});

test('enqueue appends to the end with addedAt; same plan is not duplicated', () => {
  const now = new Date('2026-11-01T11:00:00Z');
  const t = { projectDir: '/p/c', planPath: 'docs/plans/c.md', progressPath: 'docs/plans/c.progress.md' };
  const q = enqueue([item('a')], t, { now });
  assert.deepEqual(names(q), ['a', 'c']);
  assert.equal(q[1].addedAt, now.toISOString());
  assert.deepEqual(enqueue(q, t, { now }), q);
});

test('enqueue front puts plan first, moving an existing entry and keeping its addedAt', () => {
  const q = enqueue([item('a'), item('b')], { projectDir: '/p/b', planPath: 'docs/plans/b.md' }, { front: true });
  assert.deepEqual(names(q), ['b', 'a']);
  assert.equal(q[0].addedAt, item('b').addedAt);
  assert.equal(q[0].progressPath, 'docs/plans/b.progress.md');
  assert.deepEqual(names(enqueue([item('a')], item('c'), { front: true })), ['c', 'a']);
});

test('enqueue does not mutate the input', () => {
  const items = [item('a')];
  enqueue(items, item('b'), { front: true });
  assert.deepEqual(names(items), ['a']);
});

test('removeAt and moveUp use 0-based indices; out of range → unchanged', () => {
  const q = [item('a'), item('b'), item('c')];
  assert.deepEqual(names(removeAt(q, 1)), ['a', 'c']);
  assert.deepEqual(names(removeAt(q, 5)), ['a', 'b', 'c']);
  assert.deepEqual(names(moveUp(q, 2)), ['a', 'c', 'b']);
  assert.deepEqual(names(moveUp(q, 0)), ['a', 'b', 'c']);
  assert.deepEqual(names(moveUp(q, 9)), ['a', 'b', 'c']);
  assert.deepEqual(names(q), ['a', 'b', 'c']);
});

test('pickNext: empty queue → no target, nothing waiting', () => {
  assert.deepEqual(pickNext([], { readPlan: reader(PLANS) }), { target: null, waiting: [], doneTargets: [], missing: [] });
});

test('pickNext: first plan with a runnable next task wins', () => {
  const r = pickNext([item('auto'), item('planner')], { readPlan: reader(PLANS) });
  assert.deepEqual(names([r.target]), ['auto']);
});

test('pickNext: skips a user-waiting plan and reports it; planner tasks are runnable', () => {
  const r = pickNext([item('user'), item('planner')], { readPlan: reader(PLANS) });
  assert.deepEqual(names([r.target]), ['planner']);
  assert.deepEqual(names(r.waiting.map(w => w.target)), ['user']);
  assert.equal(r.waiting[0].task.id, 'Task 2');
  assert.equal(r.waiting[0].task.kind, 'user');
});

test('pickNext: skips finished plans and lists them in doneTargets', () => {
  const r = pickNext([item('done'), item('auto')], { readPlan: reader(PLANS) });
  assert.deepEqual(names([r.target]), ['auto']);
  assert.deepEqual(names(r.doneTargets), ['done']);
});

test('pickNext: reports every waiting plan, also those after the target', () => {
  const r = pickNext([item('auto'), item('user')], { readPlan: reader(PLANS) });
  assert.deepEqual(names([r.target]), ['auto']);
  assert.deepEqual(names(r.waiting.map(w => w.target)), ['user']);
});

test('pickNext: two waiting + one done → no target, both waiting (Review Focus 1)', () => {
  const plans = { ...PLANS, user2: PLANS.user };
  let reads = 0;
  const readPlan = t => (reads++, reader(plans)(t));
  const r = pickNext([item('user'), item('done'), item('user2')], { readPlan });
  assert.equal(r.target, null);
  assert.deepEqual(names(r.waiting.map(w => w.target)), ['user', 'user2']);
  assert.deepEqual(names(r.doneTargets), ['done']);
  assert.equal(reads, 3, 'each plan is read exactly once');
});

test('pickNext: all finished → no target, no waiting (caller reports done)', () => {
  const r = pickNext([item('done')], { readPlan: reader(PLANS) });
  assert.equal(r.target, null);
  assert.deepEqual(r.waiting, []);
  assert.deepEqual(names(r.doneTargets), ['done']);
});

test('pickNext: plan file gone → skipped into missing, choice goes on (Review Focus 5)', () => {
  const r = pickNext([item('gone'), item('auto')], { readPlan: reader(PLANS) });
  assert.deepEqual(names([r.target]), ['auto']);
  assert.deepEqual(names(r.missing.map(m => m.target)), ['gone']);
  assert.match(r.missing[0].error, /ENOENT/);
  const nullReader = t => (t.planPath.includes('gone') ? null : reader(PLANS)(t));
  assert.deepEqual(names(pickNext([item('gone')], { readPlan: nullReader }).missing.map(m => m.target)), ['gone']);
});

test('pickNext: returned target is the queue entry itself', () => {
  const q = [item('auto')];
  assert.equal(pickNext(q, { readPlan: reader(PLANS) }).target, q[0]);
});

test('shouldPreempt: a plan above the current one that became runnable', () => {
  const q = [item('user'), item('auto')];
  const current = { projectDir: '/p/auto', planPath: 'docs/plans/auto.md' };
  assert.equal(shouldPreempt(q, current, { readPlan: reader(PLANS) }), null);
  const ticked = { ...PLANS, user: PLANS.planner };
  assert.equal(shouldPreempt(q, current, { readPlan: reader(ticked) }), q[0]);
});

test('shouldPreempt: only plans above the current one count', () => {
  const q = [item('auto'), item('planner')];
  assert.equal(shouldPreempt(q, item('auto'), { readPlan: reader(PLANS) }), null);
});

test('shouldPreempt: done or missing plans above are ignored', () => {
  const q = [item('done'), item('gone'), item('auto')];
  assert.equal(shouldPreempt(q, item('auto'), { readPlan: reader(PLANS) }), null);
});

test('shouldPreempt: current plan not in the queue → null', () => {
  assert.equal(shouldPreempt([item('auto')], item('other'), { readPlan: reader(PLANS) }), null);
  assert.equal(shouldPreempt([item('auto')], null, { readPlan: reader(PLANS) }), null);
});

test('enqueue and shouldPreempt treat "/p/" and "/p", "./x.md" and "x.md" as the same plan', () => {
  const items = [{ projectDir: '/p/', planPath: './x.md', progressPath: 'x.progress.md', addedAt: 'a' }];
  assert.equal(enqueue(items, { projectDir: '/p', planPath: 'x.md' }).length, 1);
  assert.equal(enqueue(items, { projectDir: '/p', planPath: 'x.md' }, { front: true }).length, 1);
  const runnable = parsePlan('### Task 1: t\n- [ ] s\n');
  assert.equal(shouldPreempt(items, { projectDir: '/p', planPath: 'x.md' }, { readPlan: () => runnable }), null);
});


test('queue add stores absolute plan and progress paths relative to the project', t => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ projectDir: dir, planPath: 'p.md', stateDir: dir }));
  writeFileSync(join(dir, 'p.md'), '# Plan');
  const cli = plan => spawnSync(process.execPath,
    [fileURLToPath(new URL('../autopilot.mjs', import.meta.url)), 'queue', 'add', dir, plan],
    { encoding: 'utf8', env: { ...process.env, AUTOPILOT_CONFIG: config } });
  const result = cli(join(dir, 'p.md'));
  assert.equal(result.status, 0, result.stderr);
  const [entry] = JSON.parse(readFileSync(join(dir, 'queue.json'), 'utf8'));
  assert.equal(entry.planPath, 'p.md');
  assert.equal(entry.progressPath, 'p.progress.md');
  const again = cli('p.md');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(loadQueue(dir).items.length, 1);
});

test('enqueue rejects plans outside the project, including sibling prefixes', () => {
  for (const planPath of ['/root/other/p.md', '../p.md', '/root/x-other/p.md']) {
    assert.throws(() => enqueue([], { projectDir: '/root/x', planPath }), /План вне каталога проекта/);
  }
});

test('enqueue deduplicates absolute and relative paths in both orders without mutating input', () => {
  const relative = item('a');
  const absolute = { ...relative, planPath: '/p/a/docs/plans/a.md', progressPath: '/p/a/docs/plans/a.progress.md' };
  for (const [first, second] of [[relative, absolute], [absolute, relative]]) {
    const q = enqueue([first], second);
    assert.equal(q.length, 1);
    assert.equal(q[0].planPath, relative.planPath);
    assert.equal(q[0].progressPath, relative.progressPath);
    assert.equal(q[0].addedAt, first.addedAt);
  }
  assert.equal(absolute.planPath, '/p/a/docs/plans/a.md');
});

test('loadQueue normalizes legacy absolute plan and progress paths and preserves metadata', t => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const entry = { ...item('a'), planPath: '/p/a/docs/plans/a.md', progressPath: '/p/a/docs/plans/a.progress.md', waitingUser: { taskId: 'Task 1' } };
  writeFileSync(join(dir, 'queue.json'), JSON.stringify([entry]));
  assert.deepEqual(loadQueue(dir), { items: [{ ...entry, planPath: 'docs/plans/a.md', progressPath: 'docs/plans/a.progress.md' }] });
  assert.equal(JSON.parse(readFileSync(join(dir, 'queue.json'), 'utf8'))[0].planPath, entry.planPath, 'read does not rewrite disk');
});


test('queue add rejects an outside path before checking existence and leaves the queue intact', t => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const projectDir = join(dir, 'project');
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ projectDir, planPath: 'p.md', stateDir: dir }));
  const items = [item('a')];
  saveQueue(dir, items);
  const before = readFileSync(join(dir, 'queue.json'), 'utf8');
  writeFileSync(join(dir, 'outside.md'), '# Outside');
  for (const plan of [join(dir, 'outside.md'), join(dir, 'missing.md'), '../missing.md']) {
    const r = spawnSync(process.execPath,
      [fileURLToPath(new URL('../autopilot.mjs', import.meta.url)), 'queue', 'add', projectDir, plan],
      { encoding: 'utf8', env: { ...process.env, AUTOPILOT_CONFIG: config } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /План вне каталога проекта/);
    assert.equal(readFileSync(join(dir, 'queue.json'), 'utf8'), before);
  }
});
