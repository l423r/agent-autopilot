// Run log: one JSON line per `claude -p` run in <logDir>/runs.jsonl, and its summary by model.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_MODEL = 'по умолчанию';
export const runsFile = logDir => join(logDir, 'runs.jsonl');

export function appendRun(logDir, run) {
  mkdirSync(logDir, { recursive: true });
  appendFileSync(runsFile(logDir), JSON.stringify(run) + '\n');
}

// Broken lines (a write cut short) are counted in `skipped`, never thrown.
export function summarizeRuns(lines) {
  const byModel = {};
  let skipped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let run;
    try {
      run = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    if (!run || typeof run !== 'object') {
      skipped++;
      continue;
    }
    const m = (byModel[run.model ?? DEFAULT_MODEL] ??= { runs: 0, ok: 0, done: 0, avgDurationSec: 0, totalCostUsd: 0, tokensOut: 0, durationSum: 0 });
    m.runs++;
    if (run.result === 'ok') m.ok++;
    if (run.done) m.done++;
    m.durationSum += Number(run.durationSec) || 0;
    m.totalCostUsd += Number(run.costUsd) || 0;
    m.tokensOut += Number(run.tokens?.output) || 0;
  }
  for (const m of Object.values(byModel)) {
    m.avgDurationSec = Math.round(m.durationSum / m.runs);
    m.totalCostUsd = Math.round(m.totalCostUsd * 10_000) / 10_000;
    delete m.durationSum;
  }
  return { byModel, skipped };
}

export function statsText({ byModel, skipped }) {
  const rows = Object.entries(byModel);
  const lines = rows.length
    ? [
        'Модель | запусков | задача закрыта | ср. время | стоимость | вых. токены',
        ...rows.map(([model, m]) => `${model} | ${m.runs} | ${m.done} | ${m.avgDurationSec} с | $${m.totalCostUsd.toFixed(2)} | ${m.tokensOut}`),
      ]
    : ['Запусков пока нет'];
  if (skipped > 0) lines.push(`пропущено строк: ${skipped}`);
  return lines.join('\n');
}
