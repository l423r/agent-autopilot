// Phone notifications through ntfy (https://ntfy.sh): a plain POST to <server>/<topic>.
// Title, tags and priority go as query params so non-ASCII text needs no header encoding.

const STOP_TEXT = {
  done: { title: 'Автопилот: готово', tags: 'white_check_mark', priority: 4 },
  'waiting-user': { title: 'Автопилот ждёт вас', tags: 'raising_hand', priority: 4 },
  halted: { title: 'Автопилот застрял', tags: 'warning', priority: 5 },
  auth: { title: 'Автопилоту нужен вход в Claude', tags: 'key', priority: 5 },
  paused: { title: 'Автопилот: пауза после этапа', tags: 'pause_button', priority: 3 },
};

export function stopMessage(status, reason) {
  const t = STOP_TEXT[status] ?? { title: `Автопилот: ${status}`, tags: 'information_source', priority: 3 };
  return { ...t, message: reason };
}

// Phone buttons per notification kind; each command is a parseCommand word.
const BUTTONS = {
  done: [['Статус', 'status']],
  'waiting-user': [['Продолжить', 'resume'], ['Статус', 'status']],
  halted: [['Продолжить', 'resume'], ['Статус', 'status']],
  auth: [['Продолжить', 'resume']],
  paused: [['Продолжить', 'resume']],
  limit: [['Продолжить сейчас', 'resume']],
  task: [['Пауза', 'pause']],
};

export function buttonsFor(kind) {
  return (BUTTONS[kind] ?? []).map(([label, command]) => ({ label, command }));
}

const serverOf = cfg => (cfg.ntfyServer ?? 'https://ntfy.sh').replace(/\/$/, '');

// ntfy `http` actions: a tap POSTs the command to the command topic with the phone's token.
function actionsParam(cfg, actions) {
  if (!cfg.ntfyCommands || !cfg.ntfyCommandToken || !actions?.length) return null;
  const target = `${serverOf(cfg)}/${encodeURIComponent(`${cfg.ntfyTopic}-cmd`)}`;
  return actions.slice(0, 3)
    .map(a => `http, ${a.label}, ${target}, method=POST, body=${a.command}, headers.Authorization=Bearer ${cfg.ntfyCommandToken}`)
    .join('; ');
}

export async function notify(cfg, { title, message, tags, priority, actions }) {
  if (!cfg.ntfyTopic) return false;
  const url = new URL(`${serverOf(cfg)}/${encodeURIComponent(cfg.ntfyTopic)}`);
  if (title) url.searchParams.set('title', title);
  if (tags) url.searchParams.set('tags', tags);
  if (priority) url.searchParams.set('priority', String(priority));
  const act = actionsParam(cfg, actions);
  if (act) url.searchParams.set('actions', act);
  // A tap on the notification opens the browser panel.
  if (cfg.webPublicUrl) url.searchParams.set('click', cfg.webPublicUrl);
  try {
    const headers = cfg.ntfyToken ? { Authorization: `Bearer ${cfg.ntfyToken}` } : {};
    const res = await fetch(url, { method: 'POST', headers, body: message ?? '', signal: AbortSignal.timeout(15_000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Plan queue: a plan stopped on a user task (once per task), a finished or vanished plan, a switch.
export const waitingMessage = (label, task) => ({ title: 'Ждёт вас', message: `${label} — ${task.id}: ${task.title}`, tags: 'raising_hand', priority: 4, actions: buttonsFor('waiting-user') });
export const planDoneMessage = label => ({ title: 'План выполнен', message: `План выполнен: ${label}`, tags: 'white_check_mark', priority: 3 });
export const planMissingMessage = (label, error) => ({ title: 'План не найден', message: `Убран из очереди: ${label} (${error})`, tags: 'warning', priority: 3 });
export const switchedMessage = (label, why) => ({ title: 'Автопилот: другой план', message: `Переключено на ${label}${why ? ` (${why})` : ''}`, tags: 'twisted_rightwards_arrows', priority: 3 });
