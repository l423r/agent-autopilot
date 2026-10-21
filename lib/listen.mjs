// Subscribes to the ntfy command topic <ntfyTopic>-cmd as a JSON stream (GET …/json) and
// hands every `message` event to onMessage. Survives drops and errors by reconnecting
// (5 s, doubling up to 60 s; a successful connection resets the delay). The id of the last
// handled message is kept in sinceFile, so a reconnect or a daemon restart never replays it.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_LINE = 64 * 1024;

function readSince(file) {
  try {
    const id = readFileSync(file, 'utf8').trim();
    if (/^[A-Za-z0-9_-]{1,64}$/.test(id)) return id;
  } catch {}
  return null;
}

function writeSince(file, id) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, id + '\n');
  renameSync(tmp, file);
}

export function subscribeCommands(cfg, { sinceFile, onMessage, log }) {
  const base = cfg.__retryMs ?? 5_000;
  const max = base * 12;
  const url = `${(cfg.ntfyServer ?? 'https://ntfy.sh').replace(/\/$/, '')}/${encodeURIComponent(`${cfg.ntfyTopic}-cmd`)}/json`;
  const headers = cfg.ntfyToken ? { Authorization: `Bearer ${cfg.ntfyToken}` } : {};
  let since = readSince(sinceFile) ?? String(Math.floor(Date.now() / 1000));
  let delay = base;
  let stopped = false;
  let ctrl = null;
  let timer = null;
  let wake = null;

  async function handle(raw) {
    if (raw.length > MAX_LINE) return;
    let ev;
    try { ev = JSON.parse(raw); } catch { return; }
    if (ev?.event !== 'message' || typeof ev.id !== 'string') return;
    if (ev.id === since) return;
    try {
      await onMessage({ id: ev.id, time: ev.time, message: typeof ev.message === 'string' ? ev.message : '' });
    } catch (e) {
      log(`ntfy: ошибка обработки команды: ${e.message}`);
    }
    since = ev.id;
    try { writeSince(sinceFile, ev.id); } catch (e) { log(`ntfy: не удалось сохранить ${sinceFile}: ${e.message}`); }
  }

  async function connect() {
    ctrl = new AbortController();
    const res = await fetch(`${url}?since=${encodeURIComponent(since)}`, { headers, signal: ctrl.signal });
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    delay = base;
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (raw) await handle(raw);
        if (stopped) return;
      }
      if (buf.length > MAX_LINE) buf = '';
    }
    throw new Error('соединение закрыто');
  }

  (async () => {
    while (!stopped) {
      try {
        await connect();
      } catch (e) {
        if (stopped) break;
        log(`ntfy: канал команд недоступен (${e.message}), повтор через ${Math.round(delay / 1000)} с`);
      }
      if (stopped) break;
      await new Promise(r => { wake = r; timer = setTimeout(r, delay); });
      delay = Math.min(delay * 2, max);
    }
  })();

  return {
    stop() {
      stopped = true;
      ctrl?.abort();
      clearTimeout(timer);
      wake?.();
    },
  };
}
