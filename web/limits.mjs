// Claude usage limits (5-hour and weekly windows) from the undocumented OAuth usage endpoint.
// The token is read per call and never refreshed, logged or returned; any failure becomes { error }.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TIMEOUT_MS = 10_000;

export async function fetchLimits({ credentialsFile = '/root/.claude/.credentials.json', fetchImpl = fetch, now = new Date() } = {}) {
  let token;
  try {
    token = JSON.parse(readFileSync(credentialsFile, 'utf8'))?.claudeAiOauth?.accessToken;
  } catch (err) {
    return { error: err.code === 'ENOENT' ? 'Нет файла с токеном Claude' : 'Не прочитать файл с токеном Claude' };
  }
  if (typeof token !== 'string' || !token) return { error: 'В файле нет токена Claude' };
  const hide = text => String(text).split(token).join('***');

  let res;
  try {
    res = await fetchImpl(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { error: hide(`Запрос не удался: ${err.name === 'TimeoutError' ? 'нет ответа за 10 с' : err.message}`) };
  }
  if (!res.ok) return { error: `Сервер лимитов ответил ${res.status}` };
  let data;
  try { data = await res.json(); } catch { return { error: 'Сервер лимитов ответил не JSON' }; }
  const fiveHour = usageWindow(data?.five_hour, now);
  const week = usageWindow(data?.seven_day, now);
  if (!fiveHour || !week) return { error: 'Неизвестный формат ответа о лимитах' };
  return { fiveHour, week };
}

function usageWindow(w, now) {
  if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
  const resetsAt = typeof w.resets_at === 'string' && !Number.isNaN(Date.parse(w.resets_at)) ? w.resets_at : null;
  return resetWindow(w.utilization, resetsAt, now);
}

// Codex has no usage endpoint: its own session logs carry the last `rate_limits` event
// ({ primary: 5 h, secondary: week }, resets_at in unix seconds). Nothing found → { error }, never a throw.
const NO_CODEX_DATA = 'Нет данных о лимитах Codex';
const MAX_SESSION_FILES = 20;

export function fetchCodexLimits({ codexHome = '/root/.codex', now = new Date() } = {}) {
  try {
    for (const file of newestSessions(join(codexHome, 'sessions'))) {
      const found = lastRateLimits(file, now);
      if (found) return found;
    }
  } catch { /* unreadable sessions dir → no data */ }
  return { error: NO_CODEX_DATA };
}

// Session files (.jsonl, any depth), newest first.
function newestSessions(dir) {
  const files = [];
  const walk = d => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, e.name);
      if (e.isDirectory()) walk(path);
      else if (e.name.endsWith('.jsonl')) files.push({ path, mtime: statSync(path).mtimeMs });
    }
  };
  walk(dir);
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_SESSION_FILES).map(f => f.path);
}

function lastRateLimits(file, now) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    let event;
    try { event = JSON.parse(lines[i]); } catch { continue; }
    const r = event?.payload?.rate_limits ?? event?.rate_limits ?? event?.msg?.rate_limits;
    const fiveHour = codexWindow(r?.primary, now);
    const week = codexWindow(r?.secondary, now);
    if (fiveHour && week) return { fiveHour, week };
  }
  return null;
}

function codexWindow(w, now) {
  if (!w || typeof w.used_percent !== 'number' || !Number.isFinite(w.used_percent)) return null;
  const resetsAt = typeof w.resets_at === 'number' && Number.isFinite(w.resets_at) ? new Date(w.resets_at * 1000).toISOString() : null;
  return resetWindow(w.used_percent, resetsAt, now);
}

function resetWindow(percent, resetsAt, now) {
  if (resetsAt !== null && new Date(resetsAt) <= now) {
    return { percent: 0, resetsAt: null, reset: true };
  }
  return { percent, resetsAt };
}
