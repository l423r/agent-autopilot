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

export async function notify(cfg, { title, message, tags, priority }) {
  if (!cfg.ntfyTopic) return false;
  const url = new URL(`${(cfg.ntfyServer ?? 'https://ntfy.sh').replace(/\/$/, '')}/${encodeURIComponent(cfg.ntfyTopic)}`);
  if (title) url.searchParams.set('title', title);
  if (tags) url.searchParams.set('tags', tags);
  if (priority) url.searchParams.set('priority', String(priority));
  try {
    const res = await fetch(url, { method: 'POST', body: message ?? '', signal: AbortSignal.timeout(15_000) });
    return res.ok;
  } catch {
    return false;
  }
}
