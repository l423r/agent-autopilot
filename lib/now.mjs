// Pure presentation of daemon state and enriched queue rows; no disk access or system clock reads.
const MINUTE = 60_000;
const MONTHS = ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];

function localTime(value, now) {
  const date = new Date(value ?? NaN);
  if (!Number.isFinite(+date)) return '—';
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const today = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return today ? time : `${date.getDate()} ${MONTHS[date.getMonth()]}, ${time}`;
}

const minutes = ms => Math.max(0, Math.floor(ms / MINUTE));
const view = (kind, title, details = [], action = null) => ({ kind, title, details, action });

// queue rows: { project, planTitle, active?, next: { id, title } | null, waiting: { id, title } | null }.
// state.planTitle is read-time context for a stopped run, never a change to persisted state.
export function nowView({ state, queue = [], now }) {
  now = new Date(now);
  const heartbeat = Date.parse(state.heartbeatAt);
  if (!Number.isFinite(heartbeat) || +now - heartbeat > 3 * MINUTE) {
    return view('down', `Автопилот не отвечает с ${localTime(state.heartbeatAt, now)}`,
      ['Служба остановлена или зависла. Напиши планировщику «проверь автопилот».']);
  }
  if (state.status === 'running' && state.run) {
    const r = state.run;
    const age = Math.max(0, +now - Date.parse(r.lastOutputAt));
    const details = [
      `${r.taskId} из ${r.total}: ${r.taskTitle}`,
      `${r.executor === 'codex' ? 'Codex' : 'Claude'} ${r.model ?? '—'} · попытка ${r.attempt} из ${r.maxAttempts} · идёт ${minutes(+now - Date.parse(r.startedAt))} мин`,
      `Последний вывод ${age < MINUTE ? `${Math.floor(age / 1000)} с` : `${minutes(age)} мин`} назад`,
    ];
    if (age > 10 * MINUTE) details.push('⚠ Давно нет вывода — возможно, задача зависла');
    return view('working', `Работает: ${r.project} — «${r.planTitle}»`, details);
  }
  if (state.status === 'sleeping') {
    const next = queue.find(r => r.active && r.next && !r.waiting) ?? queue.find(r => r.next && !r.waiting);
    return view('limit', `Ждёт лимит до ${localTime(state.nextAttemptAt, now)}, дальше продолжит сам`,
      next ? [`Следующая: ${next.project} — ${next.next.id}: ${next.next.title}`] : []);
  }
  if (state.status === 'waiting-user') {
    const waiting = queue.filter(r => r.waiting);
    return view('user', `Ничего не делает: все планы в очереди ждут тебя (${waiting.length})`,
      waiting.map(r => `${r.project} — «${r.planTitle}», ${r.waiting.id}: ${r.waiting.title}`));
  }
  if (state.status === 'halted') {
    const active = queue.find(r => r.active);
    return view('stuck', `Остановился: ${state.reason ?? '—'}`,
      [`Задача ${state.currentTask ?? active?.next?.id ?? '—'} в «${state.planTitle ?? active?.planTitle ?? '—'}»`], 'resume');
  }
  if (state.status === 'paused') return view('paused', 'На паузе', ['Продолжит после кнопки «Продолжить»'], 'resume');
  if (state.status === 'auth') return view('auth', 'Нужен вход в учётку', state.reason ? [state.reason] : []);
  if (state.status === 'running') return view('idle', 'Ничего не делает: нет текущего запуска');
  return view('idle', queue.length ? 'Ничего не делает: ждёт следующего запуска' : 'Ничего не делает: очередь пуста');
}

export function nowShort(current, state) {
  switch (current.kind) {
    case 'working': return `работает · ${state.run.project} ${state.run.taskId}`;
    case 'limit': return current.title.replace(/, дальше продолжит сам$/, '').toLowerCase();
    case 'user': return `ждёт тебя (${current.details.length})`;
    case 'stuck': return 'остановился';
    case 'paused': return 'пауза';
    case 'down': return 'не отвечает';
    case 'auth': return 'нужен вход в учётку';
    default: return current.title.replace(/^Ничего не делает: /, '');
  }
}
