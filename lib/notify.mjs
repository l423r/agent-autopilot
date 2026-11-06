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

// ntfy actions: a tap on `http` POSTs the command to the command topic with the phone's token;
// `view` (an action with a url) opens the link and needs no token. At most 3 buttons: past that the
// last command button goes first, the view button stays.
function actionsParam(cfg, actions) {
  const commands = cfg.ntfyCommands && cfg.ntfyCommandToken ? actions?.filter(a => !a.url) ?? [] : [];
  const views = actions?.filter(a => a.url) ?? [];
  const keep = new Set([...commands.slice(0, Math.max(0, 3 - views.length)), ...views.slice(0, 3)]);
  const shown = actions?.filter(a => keep.has(a)) ?? [];
  if (!shown.length) return null;
  const target = `${serverOf(cfg)}/${encodeURIComponent(`${cfg.ntfyTopic}-cmd`)}`;
  return shown
    .map(a => a.url
      ? `view, ${a.label}, ${a.url}`
      : `http, ${a.label}, ${target}, method=POST, body=${a.command}, headers.Authorization=Bearer ${cfg.ntfyCommandToken}`)
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
// Up to 3 distinct links of a task text: [label](url) and bare http(s) addresses, in order.
export function linksIn(text) {
  const found = [];
  for (const m of String(text ?? '').matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) {
    const url = m[0].replace(/[.,;:!?*]+$/, '');
    if (!found.includes(url)) found.push(url);
  }
  return found.slice(0, 3);
}

export const waitingMessage = (label, task, { text, webUrl } = {}) => ({
  title: 'Ждёт вас',
  message: [`${label} — ${task.id}: ${task.title}`, ...linksIn(text)].join('\n'),
  tags: 'raising_hand',
  priority: 4,
  actions: [...buttonsFor('waiting-user'), ...(webUrl ? [{ label: 'Открыть в пульте', url: webUrl }] : [])],
});
export const planDoneMessage = label => ({ title: 'План выполнен', message: `План выполнен: ${label}`, tags: 'white_check_mark', priority: 3 });
export const planMissingMessage = (label, error) => ({ title: 'План не найден', message: `Убран из очереди: ${label} (${error})`, tags: 'warning', priority: 3 });
export const switchedMessage = (label, why) => ({ title: 'Автопилот: другой план', message: `Переключено на ${label}${why ? ` (${why})` : ''}`, tags: 'twisted_rightwards_arrows', priority: 3 });

// Executor switches (cfg.executor 'codex'): one notification each way; `until` is already formatted.
export const codexLimitMessage = until => ({ title: 'Автопилот: лимит Codex', message: `Лимит Codex до ${until}, задачу делает Claude`, tags: 'twisted_rightwards_arrows', priority: 3 });
export const codexAuthMessage = () => ({ title: 'Автопилот: Codex не авторизован', message: 'Codex не авторизован, задачу делает Claude (вход: codex login --device-auth)', tags: 'key', priority: 4 });
export const codexBackMessage = () => ({ title: 'Автопилот: снова Codex', message: 'Вернулся на Codex', tags: 'twisted_rightwards_arrows', priority: 3 });
