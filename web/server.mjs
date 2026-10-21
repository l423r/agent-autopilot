#!/usr/bin/env node
// Browser control panel: static page, chat with the planner (answers stream over SSE), plan and status,
// pause/resume through the ntfy command topic. Listens on 127.0.0.1 only; Caddy adds the password.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createChat } from './chat.mjs';
import { fetchLimits } from './limits.mjs';
import { parsePlan } from '../lib/plan.mjs';
import { loadState } from '../lib/state.mjs';
import { statusText } from '../lib/commands.mjs';
import { killOrphan } from '../lib/runner.mjs';
import { effectiveConfig, listProjects, listPlans, findPlan, requestSwitch, mentionContext } from '../lib/projects.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_TEXT = 20_000;
const MAX_BODY = 256 * 1024;
const MAX_HISTORY_BYTES = 1024 * 1024 - 1024; // the freshest entries that fit; leaves room for the envelope
const HEARTBEAT_MS = 25_000;
const MAX_UPLOAD = 8 * 1024 * 1024;
const MAX_IMAGES = 5;
const KEEP_UPLOADS = 200;
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const UPLOAD_ID = /^[0-9a-f-]{36}\.(jpg|png|webp|gif)$/;
const LIMITS_CACHE_MS = 60_000;
const COMMAND_WORDS = { pause: 'пауза', resume: 'продолжить' };
const COMMANDS_OFF = 'У автопилота выключены команды (ntfyCommands) — команду никто не выполнит';

export async function startServer(cfg, { port = cfg.webPort ?? 7690, claudeBin, indexFile = join(HERE, 'index.html'), limitsFetch = () => fetchLimits() } = {}) {
  const webDir = join(cfg.stateDir, 'web');
  // A previous server may have died mid-answer: its claude child is an orphan, and busy is not persisted.
  await killOrphan(webDir);
  const uploadsDir = join(webDir, 'uploads');
  const chat = createChat({ cfg, dir: webDir, ...(claudeBin ? { claudeBin } : {}) });
  const clients = new Set();
  let pending = ''; // text of the answer in progress, for clients that (re)connect mid-answer

  const broadcast = event => {
    const frame = sseFrame(event);
    for (const res of clients) res.write(frame);
  };

  // The daemon may switch plans at any time: read active.json on every request.
  const readPlanText = (projectDir, planPath) => {
    if (!projectDir) ({ projectDir, planPath } = effectiveConfig(cfg));
    const path = resolve(projectDir, planPath);
    return { path, markdown: readFileSync(path, 'utf8') };
  };

  const projects = () => {
    const active = effectiveConfig(cfg);
    const state = loadState(cfg.stateDir);
    return listProjects(active).map(project => {
      const plans = listPlans(project);
      const isActive = resolve(project.projectDir) === resolve(active.projectDir);
      const currentPlan = isActive ? active.planPath : (plans.find(p => !p.finished) ?? plans[0])?.planPath ?? null;
      return { name: project.name, projectDir: project.projectDir, active: isActive, status: isActive ? state.status : null, currentPlan, plans };
    });
  };

  // One upstream request per minute at most; concurrent callers share it. Errors are cached too.
  let limits = null; // { at, promise }
  const cachedLimits = () => {
    if (!limits || Date.now() - limits.at >= LIMITS_CACHE_MS) {
      limits = { at: Date.now(), promise: Promise.resolve().then(limitsFetch).catch(() => ({ error: 'Не удалось получить лимиты' })) };
    }
    return limits.promise;
  };

  const routes = {
    'GET /': (req, res) => sendFile(res, indexFile, 'text/html; charset=utf-8'),
    'GET /markdown.mjs': (req, res) => sendFile(res, join(HERE, 'markdown.mjs'), 'text/javascript; charset=utf-8'),

    'GET /api/history': (req, res) => sendJson(res, 200, { busy: chat.busy(), entries: freshest(chat.history(), MAX_HISTORY_BYTES) }),

    'POST /api/chat': async (req, res) => {
      const body = await readJson(req);
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      const images = body?.images ?? [];
      if (!Array.isArray(images) || images.length > MAX_IMAGES
        || !images.every(id => typeof id === 'string' && UPLOAD_ID.test(id) && existsSync(join(uploadsDir, id)))) {
        return sendJson(res, 400, { error: `Картинки: до ${MAX_IMAGES} загруженных` });
      }
      if ((!text && !images.length) || text.length > MAX_TEXT) return sendJson(res, 400, { error: `Нужен текст до ${MAX_TEXT} символов или картинка` });
      if (chat.busy()) return sendJson(res, 409, { error: 'Планировщик ещё отвечает' });
      pending = '';
      const active = effectiveConfig(cfg);
      const mentions = mentionContext(text, listProjects(active), { ...active, status: loadState(cfg.stateDir).status });
      const attachments = images.length
        ? ['Вложения (открой инструментом Read):', ...images.map(id => `- ${join(uploadsDir, id)}`)].join('\n')
        : null;
      const extra = [mentions, attachments].filter(Boolean).join('\n\n') || null;
      const done = chat.send(text, event => {
        if (event.type === 'delta') pending += event.text;
        broadcast(event);
      }, { extra, images });
      broadcast({ type: 'busy', busy: true, text: '' });
      done.catch(() => {}).finally(() => {
        pending = '';
        broadcast({ type: 'busy', busy: false, text: '' });
      });
      sendJson(res, 202, { ok: true });
    },

    'GET /api/events': (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      });
      res.write(sseFrame({ type: 'busy', busy: chat.busy(), text: chat.busy() ? pending : '' }));
      clients.add(res);
      const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
      beat.unref();
      req.on('close', () => { clearInterval(beat); clients.delete(res); });
    },

    'POST /api/upload': async (req, res) => {
      const ext = IMAGE_TYPES[(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()];
      const body = await readBody(req, MAX_UPLOAD);
      if (!ext) return sendJson(res, 400, { error: 'Только картинки: JPEG, PNG, WebP, GIF' });
      if (!body) return sendJson(res, 413, { error: `Картинка больше ${MAX_UPLOAD / 1024 / 1024} МБ` });
      if (!body.length) return sendJson(res, 400, { error: 'Пустой файл' });
      const id = `${randomUUID()}.${ext}`;
      mkdirSync(uploadsDir, { recursive: true });
      writeFileSync(join(uploadsDir, id), body);
      pruneUploads(uploadsDir, KEEP_UPLOADS);
      sendJson(res, 200, { id });
    },

    'POST /api/stop': (req, res) => { chat.stop(); sendJson(res, 200, { ok: true }); },

    'POST /api/reset': (req, res) => {
      if (chat.busy()) return sendJson(res, 409, { error: 'Сначала остановите ответ' });
      chat.reset();
      rmSync(uploadsDir, { recursive: true, force: true });
      mkdirSync(uploadsDir, { recursive: true });
      sendJson(res, 200, { ok: true });
    },

    'GET /api/limits': async (req, res) => sendJson(res, 200, await cachedLimits()),
    'GET /api/projects': (req, res) => sendJson(res, 200, projects()),

    'GET /api/plan': (req, res) => {
      const query = new URL(req.url, 'http://x').searchParams;
      let target = [];
      if (query.has('project') || query.has('plan')) {
        // Only plans listed for a known project: no path from the request reaches the disk.
        const found = findPlan(effectiveConfig(cfg), query.get('project'), query.get('plan'));
        if (!found) return sendJson(res, 404, { error: 'План не найден' });
        target = [found.project.projectDir, found.plan.planPath];
      }
      const { path, markdown } = readPlanText(...target);
      const { tasks } = parsePlan(markdown);
      sendJson(res, 200, { path, markdown, tasks, done: tasks.filter(t => t.done).length, total: tasks.length });
    },

    'GET /api/status': (req, res) => {
      const state = loadState(cfg.stateDir);
      let plan;
      try { plan = parsePlan(readPlanText().markdown); } catch { plan = { tasks: [] }; }
      sendJson(res, 200, { text: statusText(state, plan), state });
    },

    'POST /api/switch': async (req, res) => {
      const body = await readJson(req);
      const found = findPlan(effectiveConfig(cfg), body?.project, body?.plan);
      if (!found) return sendJson(res, 404, { error: 'План не найден' });
      if (found.plan.finished) return sendJson(res, 409, { error: 'План уже выполнен' });
      requestSwitch(cfg.stateDir, { projectDir: found.project.projectDir, planPath: found.plan.planPath, progressPath: found.plan.progressPath });
      sendJson(res, 200, { ok: true, when: loadState(cfg.stateDir).status === 'running' ? 'after-task' : 'now' });
    },

    'POST /api/command': async (req, res) => {
      const body = await readJson(req);
      const word = Object.hasOwn(COMMAND_WORDS, body?.cmd ?? '') ? COMMAND_WORDS[body.cmd] : null;
      if (!word) return sendJson(res, 400, { ok: false, error: 'Команда: pause или resume' });
      if (!cfg.ntfyTopic || !cfg.ntfyCommandToken) {
        return sendJson(res, 503, { ok: false, error: 'Канал команд ntfy не настроен (ntfyTopic, ntfyCommandToken)' });
      }
      const server = (cfg.ntfyServer ?? 'https://ntfy.sh').replace(/\/$/, '');
      try {
        const r = await fetch(`${server}/${encodeURIComponent(`${cfg.ntfyTopic}-cmd`)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.ntfyCommandToken}` },
          body: word,
          signal: AbortSignal.timeout(15_000),
        });
        if (!r.ok) return sendJson(res, 502, { ok: false, error: `ntfy ответил ${r.status}` });
        // The daemon only listens to the command topic with ntfyCommands on.
        sendJson(res, 200, cfg.ntfyCommands ? { ok: true } : { ok: true, warning: COMMANDS_OFF });
      } catch (err) {
        sendJson(res, 502, { ok: false, error: `ntfy недоступен: ${err.message}` });
      }
    },
  };

  // Only server-made names: no path from the request reaches the disk.
  const serveUpload = (req, res) => {
    const id = new URL(req.url, 'http://x').pathname.slice('/uploads/'.length);
    if (!UPLOAD_ID.test(id)) return sendJson(res, 404, { error: 'Не найдено' });
    const ext = id.split('.').pop();
    const type = Object.keys(IMAGE_TYPES).find(t => IMAGE_TYPES[t] === ext);
    sendFile(res, join(uploadsDir, id), type, 'private, max-age=31536000, immutable');
  };

  const server = createServer(async (req, res) => {
    let path;
    try { path = new URL(req.url, 'http://x').pathname; } catch { return sendJson(res, 400, { error: 'Неверный адрес' }); }
    const route = req.method === 'GET' && path.startsWith('/uploads/') ? serveUpload : routes[`${req.method} ${path}`];
    if (!route) return sendJson(res, 404, { error: 'Не найдено' });
    try {
      await route(req, res);
    } catch (err) {
      if (!res.headersSent) sendJson(res, err.status ?? 500, { error: err.status ? err.message : `Ошибка сервера: ${err.message}` });
      else res.end();
    }
  });

  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => { server.off('error', fail); ok(); });
  });

  return {
    port: server.address().port,
    close: () => new Promise(r => {
      for (const res of clients) res.end();
      clients.clear();
      server.close(() => r());
      server.closeAllConnections();
    }),
  };
}

// Whole entries from the end while their JSON fits in `limit` bytes.
function freshest(entries, limit) {
  let size = 0;
  let i = entries.length;
  while (i > 0) {
    const bytes = Buffer.byteLength(JSON.stringify(entries[i - 1])) + 1;
    if (size + bytes > limit) break;
    size += bytes;
    i--;
  }
  return entries.slice(i);
}

const sseFrame = ({ type, ...data }) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendFile(res, path, type, cache = 'no-cache') {
  let body;
  try { body = readFileSync(path); } catch { return sendJson(res, 404, { error: 'Не найдено' }); }
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
  res.end(body);
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

// The whole body, or null past `limit` (the rest is drained so the client still reads the answer).
async function readBody(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= limit) chunks.push(chunk);
  }
  return size > limit ? null : Buffer.concat(chunks);
}

// Keeps the `keep` newest uploads.
function pruneUploads(dir, keep) {
  const files = readdirSync(dir).flatMap(name => {
    try { return [{ name, mtime: statSync(join(dir, name)).mtimeMs }]; } catch { return []; }
  });
  files.sort((a, b) => b.mtime - a.mtime);
  for (const { name } of files.slice(keep)) rmSync(join(dir, name), { force: true });
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw badRequest('Слишком большой запрос');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw badRequest('Неверный JSON'); }
}

function loadConfig() {
  const path = process.env.AUTOPILOT_CONFIG ?? join(HERE, '..', 'config.json');
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  cfg.autopilotDir ??= resolve(HERE, '..');
  cfg.stateDir ??= join(cfg.autopilotDir, 'state');
  cfg.logDir ??= join(cfg.autopilotDir, 'logs');
  return cfg;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const cfg = loadConfig();
  const { port } = await startServer(cfg);
  console.log(`Пульт слушает http://127.0.0.1:${port}/`);
}
