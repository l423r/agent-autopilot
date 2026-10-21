// Claude usage limits (5-hour and weekly windows) from the undocumented OAuth usage endpoint.
// The token is read per call and never refreshed, logged or returned; any failure becomes { error }.
import { readFileSync } from 'node:fs';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TIMEOUT_MS = 10_000;

export async function fetchLimits({ credentialsFile = '/root/.claude/.credentials.json', fetchImpl = fetch } = {}) {
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
  const fiveHour = usageWindow(data?.five_hour);
  const week = usageWindow(data?.seven_day);
  if (!fiveHour || !week) return { error: 'Неизвестный формат ответа о лимитах' };
  return { fiveHour, week };
}

function usageWindow(w) {
  if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
  const resetsAt = typeof w.resets_at === 'string' && !Number.isNaN(Date.parse(w.resets_at)) ? w.resets_at : null;
  return { percent: w.utilization, resetsAt };
}
