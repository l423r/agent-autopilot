// Turns the result of one `claude -p` run into ok | limit | auth | error | timeout,
// and extracts the limit reset time from the message when it can.

const MIN_AHEAD_MS = 60_000;
const MAX_AHEAD_MS = 8 * 86_400_000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function classify({ exitCode, output, timedOut }, now, cfg) {
  if (timedOut) return { kind: 'timeout' };
  if (exitCode === 0 && !reportsError(output)) return { kind: 'ok' };

  const matches = patterns => patterns.some(p => new RegExp(p, 'i').test(output));
  if (matches(cfg.authPatterns)) return { kind: 'auth' };
  if (matches(cfg.limitPatterns)) {
    const resetAt = parseResetTime(output, now);
    const ahead = resetAt ? resetAt.getTime() - now.getTime() : -1;
    return ahead >= MIN_AHEAD_MS && ahead <= MAX_AHEAD_MS ? { kind: 'limit', resetAt } : { kind: 'limit' };
  }
  return { kind: exitCode === 0 ? 'ok' : 'error' };
}

// `--output-format json` prints {"type":"result","is_error":...}; an exit code of 0 with
// is_error:true still means the run failed (that is how limit messages can arrive).
function reportsError(output) {
  const start = output.lastIndexOf('{"type":"result"');
  if (start === -1) return false;
  try {
    return JSON.parse(output.slice(start)).is_error === true;
  } catch {
    return false;
  }
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
