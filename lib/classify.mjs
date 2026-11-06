// Turns the result of one `claude -p` or `codex exec --json` run into ok | limit | auth | error | timeout,
// and extracts the limit reset time from the message (or Codex rate_limits) when it can.

const MIN_AHEAD_MS = 60_000;
const MAX_AHEAD_MS = 8 * 86_400_000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function classify({ exitCode, output, timedOut }, now, cfg, executor = 'claude') {
  if (timedOut) return { kind: 'timeout' };
  if (executor === 'codex') return classifyCodex(exitCode, output, now);
  if (exitCode === 0 && !reportsError(output)) return { kind: 'ok' };

  const matches = patterns => patterns.some(p => new RegExp(p, 'i').test(output));
  if (matches(cfg.authPatterns)) return { kind: 'auth' };
  if (matches(cfg.limitPatterns)) {
    return limitResult(parseResetTime(output, now), now);
  }
  return { kind: exitCode === 0 ? 'ok' : 'error' };
}

function limitResult(resetAt, now) {
  const ahead = resetAt ? resetAt.getTime() - now.getTime() : -1;
  return ahead >= MIN_AHEAD_MS && ahead <= MAX_AHEAD_MS ? { kind: 'limit', resetAt } : { kind: 'limit' };
}

// Codex rules are fixed here, not in cfg: cfg.authPatterns/limitPatterns are Claude's messages.
const CODEX_AUTH = [/\b401\b.*unauthorized/i, /not logged in/i, /codex login/i, /refresh token/i, /token (has )?(expired|been revoked)/i];
const CODEX_LIMIT = [/hit your usage limit/i, /usage_limit_reached/i, /usage limit reached/i, /exceeded retry limit, last status: 429/i];
const DETAIL_CHARS = 500;

// `codex exec --json` prints JSONL events; the run ended well when a turn completed and none failed.
// Only the failure text is matched (turn.failed, else the last error event; without JSON — the raw
// output), so an agent message that talks about limits does not turn a success into a limit.
// «Reconnecting…» error events before a turn.completed are transient and ignored.
function classifyCodex(exitCode, output, now) {
  const events = codexEvents(output);
  const failed = events.findLast(e => e.type === 'turn.failed');
  if (!failed && (exitCode === 0 || events.some(e => e.type === 'turn.completed'))) return { kind: 'ok' };
  const message = failed?.error?.message ?? events.findLast(e => e.type === 'error')?.message;
  const text = message ?? output;
  if (CODEX_AUTH.some(p => p.test(text))) return { kind: 'auth' };
  if (CODEX_LIMIT.some(p => p.test(text))) {
    return limitResult(rateLimitReset(events) ?? parseResetTime(retryAsReset(text), now), now);
  }
  return { kind: 'error', detail: (message ?? output.trimEnd()).slice(-DETAIL_CHARS) };
}

function codexEvents(output) {
  const events = [];
  for (const line of output.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e.type === 'string') events.push(e);
    } catch { /* stderr or a cut line */ }
  }
  return events;
}

// The last rate_limits snapshot (top level, or in a payload/msg wrapper): the latest reset among the
// exhausted windows (both full → the later one is when work can resume); none full → null.
function rateLimitReset(events) {
  const e = events.findLast(e => (e.rate_limits ?? e.payload?.rate_limits ?? e.msg?.rate_limits));
  const limits = e && (e.rate_limits ?? e.payload?.rate_limits ?? e.msg?.rate_limits);
  if (!limits) return null;
  const resets = [limits.primary, limits.secondary]
    .filter(w => w && w.used_percent >= 100 && typeof w.resets_at === 'number')
    .map(w => w.resets_at * 1000);
  return resets.length ? new Date(Math.max(...resets)) : null;
}

// Codex says «try again at Oct 22nd, 2026 9:00 AM» or «try again at 9:00 AM» (server local time);
// rewritten into the «resets Oct 22, 9:00 AM» shape parseResetTime knows. No such phrase → ''.
function retryAsReset(text) {
  const m = text.match(/try again at ([^.]*(?:am|pm))/i);
  if (!m) return '';
  return 'resets ' + m[1].replace(/(\d{1,2})(?:st|nd|rd|th)\b/, '$1').replace(/,\s*\d{4}\b/, ',');
}

// `--output-format json` prints {"type":"result","is_error":...}; an exit code of 0 with
// is_error:true still means the run failed (that is how limit messages can arrive).
function reportsError(output) {
  return resultOf(output)?.is_error === true;
}

function resultOf(output) {
  const start = output.lastIndexOf('{"type":"result"');
  if (start === -1) return null;
  try {
    return JSON.parse(output.slice(start));
  } catch {
    return null;
  }
}

// Tokens and cost of one run, from the same result JSON; null when Claude printed none. Codex reports
// tokens in turn.completed (summed over turns) and no cost.
export function usageOf(output, executor = 'claude') {
  if (executor === 'codex') return codexUsage(output);
  const r = resultOf(output);
  const u = r?.usage;
  return {
    tokens: u ? {
      input: u.input_tokens ?? null,
      output: u.output_tokens ?? null,
      cacheRead: u.cache_read_input_tokens ?? null,
      cacheWrite: u.cache_creation_input_tokens ?? null,
    } : null,
    costUsd: typeof r?.total_cost_usd === 'number' ? r.total_cost_usd : null,
  };
}

function codexUsage(output) {
  const turns = codexEvents(output).filter(e => e.type === 'turn.completed' && e.usage);
  if (!turns.length) return { tokens: null, costUsd: null };
  const sum = key => turns.reduce((n, t) => n + (t.usage[key] ?? 0), 0);
  return { tokens: { input: sum('input_tokens'), output: sum('output_tokens'), cacheRead: sum('cached_input_tokens'), cacheWrite: null }, costUsd: null };
}

export function parseResetTime(text, now) {
  const epoch = text.match(/\|(\d{10})\b/);
  if (epoch) return new Date(Number(epoch[1]) * 1000);

  const m = text.match(
    /resets?\s+(?:at\s+)?(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i,
  );
  if (!m) return null;
  const [, monName, dayStr, hStr, minStr, ampm, zone] = m;
  let hour = Number(hStr);
  const minute = minStr ? Number(minStr) : 0;
  if (!ampm && !minStr) return null; // a bare number is not a time
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  const tz = zone && isValidZone(zone.trim()) ? zone.trim() : undefined;

  const today = wallDate(now, tz);
  if (monName) {
    const month = MONTHS.indexOf(monName.toLowerCase());
    if (month === -1) return null;
    let candidate = zonedInstant(today.year, month, Number(dayStr), hour, minute, tz);
    if (candidate < now) candidate = zonedInstant(today.year + 1, month, Number(dayStr), hour, minute, tz);
    return candidate;
  }
  let candidate = zonedInstant(today.year, today.month, today.day, hour, minute, tz);
  if (candidate <= now) candidate = zonedInstant(today.year, today.month, today.day + 1, hour, minute, tz);
  return candidate;
}

function isValidZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function wallDate(date, tz) {
  if (!tz) return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() };
  const p = partsIn(date, tz);
  return { year: p.year, month: p.month - 1, day: p.day };
}

function partsIn(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  const out = {};
  for (const { type, value } of fmt.formatToParts(date)) if (type !== 'literal') out[type] = Number(value);
  return out;
}

// The instant whose wall-clock time in `tz` (server local time when undefined) is the given one.
function zonedInstant(year, month, day, hour, minute, tz) {
  if (!tz) return new Date(year, month, day, hour, minute);
  const guess = Date.UTC(year, month, day, hour, minute);
  const p = partsIn(new Date(guess), tz);
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - guess;
  return new Date(guess - offset);
}
