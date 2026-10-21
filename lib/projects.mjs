// Projects the autopilot can work on, their plans, the active plan (<stateDir>/active.json) and
// switch requests from the panel (<stateDir>/switch.json, applied by the daemon between tasks).
// Paths planPath/progressPath/plansDir are relative to projectDir, as in config.json.
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { parsePlan } from './plan.mjs';
import { initialState } from './decide.mjs';
import { saveState } from './state.mjs';

export function listProjects(cfg) {
  if (!Array.isArray(cfg.projects)) {
    return [{ name: basename(cfg.projectDir), projectDir: cfg.projectDir, plansDir: dirname(cfg.planPath), progressPath: cfg.progressPath }];
  }
  return cfg.projects.map(p => ({ ...p, name: p.name ?? basename(p.projectDir) }));
}

export function progressPathFor(project, planPath) {
  return project.progressPath ?? planPath.replace(/\.md$/, '.progress.md');
}

export function listPlans(project) {
  let names;
  try {
    names = readdirSync(resolve(project.projectDir, project.plansDir), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const journal = project.progressPath && resolve(project.projectDir, project.progressPath);
  return names
    .filter(d => d.isFile() && d.name.endsWith('.md') && !d.name.endsWith('.progress.md'))
    .map(d => join(project.plansDir, d.name))
    .filter(planPath => resolve(project.projectDir, planPath) !== journal)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .map(planPath => {
      const { tasks } = parsePlan(readFileSync(resolve(project.projectDir, planPath), 'utf8'));
      const done = tasks.filter(t => t.done).length;
      return { planPath, progressPath: progressPathFor(project, planPath), done, total: tasks.length, finished: tasks.length > 0 && done === tasks.length };
    });
}

export function findPlan(cfg, projectName, planPath) {
  const project = listProjects(cfg).find(p => p.name === projectName);
  const plan = project && listPlans(project).find(p => p.planPath === planPath);
  return plan ? { project, plan } : null;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(dir, name, value) {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${name}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, join(dir, name));
}

const pickTarget = ({ projectDir, planPath, progressPath }) => ({ projectDir, planPath, progressPath });

export function effectiveConfig(cfg) {
  const active = cfg.stateDir && readJson(join(cfg.stateDir, 'active.json'));
  if (!active || typeof active.projectDir !== 'string' || typeof active.planPath !== 'string') return { ...cfg };
  return { ...cfg, ...pickTarget(active) };
}

export function requestSwitch(stateDir, target) {
  writeJsonAtomic(stateDir, 'switch.json', pickTarget(target));
}

export function takeSwitch(stateDir) {
  // Claim by rename first, so a request written while we read is never lost.
  const claimed = join(stateDir, `.switch.json.${process.pid}.taken`);
  try {
    renameSync(join(stateDir, 'switch.json'), claimed);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const target = readJson(claimed);
  unlinkSync(claimed);
  return target && typeof target.projectDir === 'string' && typeof target.planPath === 'string' ? target : null;
}

export function applySwitch(stateDir, target) {
  writeJsonAtomic(stateDir, 'active.json', pickTarget(target));
  saveState(stateDir, { ...initialState(), status: 'idle', reason: `Переключено на ${basename(target.planPath)}`, updatedAt: new Date().toISOString() });
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Service block for the planner about the projects named as `@name` in a chat message; null if none.
// activeCfg is effectiveConfig(cfg) plus the daemon's `status`.
export function mentionContext(text, projects, activeCfg) {
  const lines = projects
    .filter(p => new RegExp(`(^|\\s)@${escapeRe(p.name)}(?=$|[\\s.,:;!?])`).test(text))
    .map(project => {
      const active = resolve(project.projectDir) === resolve(activeCfg.projectDir);
      let planPath = activeCfg.planPath;
      let progressPath = activeCfg.progressPath;
      if (!active) {
        const plans = listPlans(project);
        const plan = plans.find(p => !p.finished) ?? plans[0];
        planPath = plan?.planPath ?? 'нет';
        progressPath = plan?.progressPath ?? 'нет';
      }
      const autopilot = active ? `активен (${activeCfg.status})` : 'не активен';
      return `- @${project.name}: projectDir=${project.projectDir}, план=${planPath}, прогресс=${progressPath}, автопилот: ${autopilot}`;
    });
  return lines.length ? ['[Проекты из сообщения]', ...lines].join('\n') : null;
}
