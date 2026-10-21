import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listProjects, progressPathFor, listPlans, findPlan, effectiveConfig, requestSwitch, takeSwitch, applySwitch,
  mentionContext, projectError, projectByDir,
} from '../lib/projects.mjs';
import { loadState, saveState } from '../lib/state.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'projects');
const ALPHA = join(FIX, 'alpha');
const BETA = join(FIX, 'beta');

const cfgWithProjects = stateDir => ({
  stateDir,
  projectDir: ALPHA,
  planPath: 'plans/2026-02-b.md',
  progressPath: 'plans/journal.md',
  projects: [
    { name: 'alpha', projectDir: ALPHA, plansDir: 'plans', progressPath: 'plans/journal.md' },
    { name: 'beta', projectDir: BETA, plansDir: 'plans' },
  ],
});

const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const tempDir = prefix => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d; };

test('listProjects без projects → один проект из старых полей', () => {
  const cfg = { projectDir: '/root/sigaret-counter', planPath: 'docs/superpowers/plans/x.md', progressPath: 'docs/superpowers/progress.md' };
  assert.deepEqual(listProjects(cfg), [
    { name: 'sigaret-counter', projectDir: '/root/sigaret-counter', plansDir: 'docs/superpowers/plans', progressPath: 'docs/superpowers/progress.md' },
  ]);
});

test('listProjects с projects → name по умолчанию из папки', () => {
  const cfg = { projects: [{ projectDir: '/root/agent-autopilot', plansDir: 'docs/plans' }, { name: 'sig', projectDir: '/root/sigaret-counter', plansDir: 'p' }] };
  assert.deepEqual(listProjects(cfg).map(p => p.name), ['agent-autopilot', 'sig']);
});

test('progressPathFor: progressPath проекта или <план>.progress.md', () => {
  assert.equal(progressPathFor({ progressPath: 'docs/progress.md' }, 'docs/plans/a.md'), 'docs/progress.md');
  assert.equal(progressPathFor({}, 'docs/plans/a.md'), 'docs/plans/a.progress.md');
});

test('listPlans пропускает *.progress.md, progressPath, подпапки и не-.md; считает прогресс', () => {
  const [alpha, beta] = listProjects(cfgWithProjects('/nonexistent'));
  const plans = listPlans(alpha);
  assert.deepEqual(plans.map(p => p.planPath), ['plans/2026-03-empty.md', 'plans/2026-02-b.md', 'plans/2026-01-a.md']);
  const [empty, b, a] = plans;
  assert.deepEqual(empty, { planPath: 'plans/2026-03-empty.md', progressPath: 'plans/journal.md', done: 0, total: 0, finished: false });
  assert.deepEqual(b, { planPath: 'plans/2026-02-b.md', progressPath: 'plans/journal.md', done: 1, total: 3, finished: false });
  assert.equal(a.finished, true);
  assert.deepEqual(listPlans(beta), [{ planPath: 'plans/other.md', progressPath: 'plans/other.progress.md', done: 0, total: 1, finished: false }]);
});

test('listPlans: нет папки → пустой список', () => {
  assert.deepEqual(listPlans({ name: 'x', projectDir: '/nonexistent', plansDir: 'plans' }), []);
});

test('findPlan: найденный план и защита от чужих путей', () => {
  const cfg = cfgWithProjects('/nonexistent');
  const hit = findPlan(cfg, 'alpha', 'plans/2026-02-b.md');
  assert.equal(hit.project.name, 'alpha');
  assert.equal(hit.plan.total, 3);
  assert.equal(findPlan(cfg, 'alpha', '../../../../etc/passwd'), null);
  assert.equal(findPlan(cfg, 'alpha', 'plans/../../beta/plans/other.md'), null);
  assert.equal(findPlan(cfg, 'alpha', join(ALPHA, 'plans/2026-02-b.md')), null);
  assert.equal(findPlan(cfg, 'alpha', 'plans/other.md'), null);
  assert.equal(findPlan(cfg, 'alpha', 'plans/2026-02-b.progress.md'), null);
  assert.equal(findPlan(cfg, 'alpha', 'plans/journal.md'), null);
  assert.equal(findPlan(cfg, 'nobody', 'plans/other.md'), null);
  assert.equal(findPlan(cfg, 'beta', 'plans/other.md').project.name, 'beta');
});

test('effectiveConfig: без active.json — исходные пути, с ним — новые', () => {
  const dir = tempDir('ap-');
  const cfg = cfgWithProjects(dir);
  const same = effectiveConfig(cfg);
  assert.deepEqual(same, cfg);
  assert.notEqual(same, cfg);

  writeFileSync(join(dir, 'active.json'), JSON.stringify({ projectDir: BETA, planPath: 'plans/other.md', progressPath: 'plans/other.progress.md' }));
  const eff = effectiveConfig(cfg);
  assert.equal(eff.projectDir, BETA);
  assert.equal(eff.planPath, 'plans/other.md');
  assert.equal(eff.progressPath, 'plans/other.progress.md');
  assert.equal(eff.stateDir, dir);
  assert.equal(cfg.projectDir, ALPHA, 'исходный cfg не меняется');

  writeFileSync(join(dir, 'active.json'), '{ broken');
  assert.equal(effectiveConfig(cfg).projectDir, ALPHA, 'нечитаемый active.json игнорируется');
});

test('requestSwitch дважды → takeSwitch отдаёт второй, повторный → null', () => {
  const dir = tempDir('ap-');
  assert.equal(takeSwitch(dir), null);
  requestSwitch(dir, { projectDir: ALPHA, planPath: 'plans/2026-02-b.md', progressPath: 'plans/journal.md' });
  requestSwitch(dir, { projectDir: BETA, planPath: 'plans/other.md', progressPath: 'plans/other.progress.md' });
  assert.deepEqual(takeSwitch(dir), { projectDir: BETA, planPath: 'plans/other.md', progressPath: 'plans/other.progress.md' });
  assert.equal(takeSwitch(dir), null);
  assert.deepEqual(readdirSync(dir), []);
});

test('applySwitch пишет active.json и сбрасывает состояние', () => {
  const dir = tempDir('ap-');
  saveState(dir, { status: 'halted', currentTask: 'Task 2', attempts: { 'Task 2': 3 }, nextAttemptAt: '2026-10-21T10:00:00.000Z', reason: 'x', updatedAt: null });
  const target = { projectDir: BETA, planPath: 'plans/other.md', progressPath: 'plans/other.progress.md' };
  applySwitch(dir, target);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'active.json'), 'utf8')), target);
  const s = loadState(dir);
  assert.equal(s.status, 'idle');
  assert.deepEqual(s.attempts, {});
  assert.equal(s.currentTask, null);
  assert.equal(s.nextAttemptAt, null);
  assert.equal(s.reason, 'Переключено на other.md');
  assert.ok(!Number.isNaN(Date.parse(s.updatedAt)));
  assert.deepEqual(readdirSync(dir).sort(), ['active.json', 'state.json']);
  assert.equal(effectiveConfig({ stateDir: dir, projectDir: ALPHA, planPath: 'a.md' }).planPath, 'plans/other.md');
});

const ACTIVE = { projectDir: ALPHA, planPath: 'plans/2026-02-b.md', progressPath: 'plans/journal.md', status: 'running' };

test('mentionContext: два проекта в одном сообщении → две строки', () => {
  const projects = listProjects(cfgWithProjects('/nonexistent'));
  assert.equal(mentionContext('глянь @alpha и @beta, пожалуйста', projects, ACTIVE), [
    '[Проекты из сообщения]',
    `- @alpha: projectDir=${ALPHA}, план=plans/2026-02-b.md, прогресс=plans/journal.md, автопилот: активен (running)`,
    `- @beta: projectDir=${BETA}, план=plans/other.md, прогресс=plans/other.progress.md, автопилот: не активен`,
  ].join('\n'));
});

test('mentionContext: одно имя дважды → одна строка; знаки препинания после имени', () => {
  const projects = listProjects(cfgWithProjects('/nonexistent'));
  const block = mentionContext('@beta: план готов? Запусти @beta!', projects, ACTIVE);
  assert.equal(block.split('\n').length, 2);
  assert.match(block, /^- @beta: /m);
});

test('mentionContext: адрес почты, неизвестное имя, имя-префикс → null', () => {
  const projects = listProjects(cfgWithProjects('/nonexistent'));
  assert.equal(mentionContext('пиши на a@beta.ru или @nope, @alphabet', projects, ACTIVE), null);
  assert.equal(mentionContext('без упоминаний', projects, ACTIVE), null);
});

test('mentionContext: регистр не важен', () => {
  const projects = [{ name: 'sigaret', projectDir: BETA, plansDir: 'plans' }];
  const want = `[Проекты из сообщения]\n- @sigaret: projectDir=${BETA}, план=plans/other.md, прогресс=plans/other.progress.md, автопилот: не активен`;
  assert.equal(mentionContext('что с @Sigaret?', projects, ACTIVE), want);
  assert.equal(mentionContext('@SIGARET', projects, ACTIVE), want);
  assert.equal(mentionContext('@sigaret', projects, ACTIVE), want);
  assert.equal(mentionContext('пиши на a@Sigaret.ru', projects, ACTIVE), null);
});

test('projectError: нет plansDir, нет projectDir, нет папки → текст; исправный → null', () => {
  assert.equal(projectError({ name: 'x', projectDir: ALPHA }), 'Нет plansDir');
  assert.equal(projectError({ name: 'x', plansDir: 'plans' }), 'Нет projectDir');
  assert.equal(projectError({ name: 'x', projectDir: '/nonexistent', plansDir: 'plans' }), 'Нет папки /nonexistent/plans');
  assert.equal(projectError({ name: 'alpha', projectDir: ALPHA, plansDir: 'plans' }), null);
});

test('битая запись в projects не ломает findPlan и mentionContext для остальных', () => {
  const cfg = cfgWithProjects('/nonexistent');
  cfg.projects.push({ name: 'broken', projectDir: BETA });
  assert.equal(findPlan(cfg, 'broken', 'plans/other.md'), null);
  assert.equal(findPlan(cfg, 'beta', 'plans/other.md').project.name, 'beta');
  const block = mentionContext('@broken и @beta', listProjects(cfg), ACTIVE);
  assert.match(block, /^- @broken: ошибка в config\.json: Нет plansDir$/m);
  assert.match(block, /^- @beta: projectDir=/m);
});

test('effectiveConfig: active.json без progressPath', () => {
  const dir = tempDir('ap-');
  const cfg = cfgWithProjects(dir);
  writeFileSync(join(dir, 'active.json'), JSON.stringify({ projectDir: ALPHA, planPath: 'plans/2026-01-a.md' }));
  assert.equal(effectiveConfig(cfg).progressPath, 'plans/journal.md', 'progressPath проекта');
  writeFileSync(join(dir, 'active.json'), JSON.stringify({ projectDir: BETA + '/', planPath: 'plans/other.md' }));
  assert.equal(effectiveConfig(cfg).progressPath, 'plans/other.progress.md', 'проект без progressPath');
  writeFileSync(join(dir, 'active.json'), JSON.stringify({ projectDir: '/elsewhere', planPath: 'docs/p.md' }));
  assert.equal(effectiveConfig(cfg).progressPath, 'docs/p.progress.md', 'проект не найден');
});

test('projectByDir: запись без projectDir не роняет поиск (переключение плана в демоне)', () => {
  const cfg = cfgWithProjects('/nonexistent');
  cfg.projects.unshift({ name: 'broken', plansDir: 'plans' });
  assert.equal(projectByDir(cfg, BETA + '/').name, 'beta');
  assert.equal(projectByDir(cfg, '/elsewhere'), undefined);
});
