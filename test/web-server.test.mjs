import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, readdirSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { startServer } from '../web/server.mjs';
import { pidRecord } from '../lib/pidfile.mjs';

const fake = fileURLToPath(new URL('./fixtures/fake-claude-stream.mjs', import.meta.url));
chmodSync(fake, 0o755);
const samplePlan = fileURLToPath(new URL('./fixtures/plan-sample.md', import.meta.url));
const ANSWER = 'Привет.\n\nЭто планировщик.\n\nЧем помочь?';
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let root, cfg, srv, ntfy, published, base;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ap-web-'));
  published = [];
  ntfy = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      published.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.end('{}');
    });
  });
  await new Promise(r => ntfy.listen(0, '127.0.0.1', r));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Пульт</title>');
  cfg = {
    projectDir: root,
    planPath: 'plan.md',
    autopilotDir: root,
    stateDir: join(root, 'state'),
    ntfyServer: `http://127.0.0.1:${ntfy.address().port}`,
    ntfyTopic: 'topic',
    ntfyCommandToken: 'tok-cmd',
    ntfyCommands: true,
  };
  writeFileSync(join(root, 'plan.md'), readFileSync(samplePlan, 'utf8'));
  process.env.FAKE_STREAM = 'ok';
  delete process.env.FAKE_ARGV;
});

afterEach(async () => {
  await srv?.close();
  srv = null;
  await new Promise(r => ntfy.close(r));
  rmSync(root, { recursive: true, force: true });
});

async function start() {
  srv = await startServer(cfg, { port: 0, claudeBin: fake, indexFile: join(root, 'index.html') });
  base = `http://127.0.0.1:${srv.port}`;
  return srv;
}

const get = path => fetch(base + path);
const post = (path, body) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
});
const json = async res => res.json();

async function waitFor(check, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error('timed out');
}
const idle = () => waitFor(async () => !(await json(await get('/api/history'))).busy);

// Reads SSE events from /api/events until `until(events)` is true; then disconnects.
async function sse(until, ms = 5000) {
  const ctrl = new AbortController();
  const res = await fetch(base + '/api/events', { signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const events = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    while (!until(events)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const type = block.match(/^event: (.*)$/m)?.[1];
        const data = block.match(/^data: (.*)$/m)?.[1];
        if (type) events.push({ type, ...JSON.parse(data) });
      }
    }
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
  return events;
}

test('GET / serves index.html, GET /markdown.mjs serves the module', async () => {
  await start();
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /Пульт/);
  const md = await get('/markdown.mjs');
  assert.equal(md.status, 200);
  assert.match(md.headers.get('content-type'), /text\/javascript/);
  assert.match(await md.text(), /export function renderMarkdown/);
  assert.equal((await get('/nope')).status, 404);
});

test('chat: 202, SSE delivers deltas and done, history has the answer', async () => {
  await start();
  process.env.FAKE_STREAM = 'slow';
  const events = sse(ev => ev.some(e => e.type === 'done'));
  await sleep(100);
  const res = await post('/api/chat', { text: 'привет' });
  assert.equal(res.status, 202);
  const got = await events;
  assert.equal(got[0].type, 'busy');
  const deltas = got.filter(e => e.type === 'delta').map(e => e.text).join('');
  assert.equal(deltas, ANSWER);
  assert.equal(got.find(e => e.type === 'done').text, ANSWER);
  await idle();
  const h = await json(await get('/api/history'));
  assert.equal(h.busy, false);
  assert.deepEqual(h.entries.map(e => e.role), ['user', 'assistant']);
});

test('chat: 400 for empty or too long text or bad json, 409 while busy', async () => {
  await start();
  assert.equal((await post('/api/chat', { text: '   ' })).status, 400);
  assert.equal((await post('/api/chat', {})).status, 400);
  assert.equal((await post('/api/chat', '{oops')).status, 400);
  assert.equal((await post('/api/chat', { text: 'x'.repeat(20_001) })).status, 400);
  process.env.FAKE_STREAM = 'slow';
  assert.equal((await post('/api/chat', { text: 'x'.repeat(20_000) })).status, 202);
  assert.equal((await post('/api/chat', { text: 'ещё' })).status, 409);
  assert.equal((await post('/api/reset')).status, 409);
  await idle();
});

test('client disconnecting mid-answer does not lose the answer', async () => {
  await start();
  process.env.FAKE_STREAM = 'slow';
  const events = sse(ev => ev.some(e => e.type === 'delta'));
  await sleep(100);
  await post('/api/chat', { text: 'привет' });
  const got = await events; // disconnected after the first delta
  assert.ok(!got.some(e => e.type === 'done'));
  await idle();
  const h = await json(await get('/api/history'));
  assert.equal(h.entries.at(-1).role, 'assistant');
  assert.equal(h.entries.at(-1).text, ANSWER);
});

test('reconnecting during an answer gets busy state and the text so far', async () => {
  await start();
  process.env.FAKE_STREAM = 'slow';
  await post('/api/chat', { text: 'привет' });
  await sleep(750); // two of three slow parts are out
  const got = await sse(ev => ev.some(e => e.type === 'done'));
  assert.equal(got[0].type, 'busy');
  assert.equal(got[0].busy, true);
  assert.ok(got[0].text.startsWith('Привет'), got[0].text);
  const rest = got.filter(e => e.type === 'delta').map(e => e.text).join('');
  assert.equal(got[0].text + rest, ANSWER);
  await idle();
});

test('stop kills the answer; reset clears history', async () => {
  await start();
  process.env.FAKE_STREAM = 'slow';
  await post('/api/chat', { text: 'привет' });
  await sleep(100);
  assert.equal((await post('/api/stop')).status, 200);
  await idle();
  let h = await json(await get('/api/history'));
  assert.equal(h.entries.at(-1).role, 'error');
  assert.match(h.entries.at(-1).text, /Остановлено/);
  assert.equal((await post('/api/reset')).status, 200);
  h = await json(await get('/api/history'));
  assert.deepEqual(h.entries, []);
});

test('GET /api/plan returns markdown and task counts', async () => {
  await start();
  const p = await json(await get('/api/plan'));
  assert.equal(p.path, join(root, 'plan.md'));
  assert.equal(p.markdown, readFileSync(samplePlan, 'utf8'));
  assert.ok(p.total > 0);
  assert.equal(p.tasks.length, p.total);
  assert.equal(p.done, p.tasks.filter(t => t.done).length);
  for (const t of p.tasks) assert.ok(Number.isInteger(t.boxes) && Number.isInteger(t.checked), `${t.id} has step counts`);
});

const FIX = fileURLToPath(new URL('./fixtures/projects', import.meta.url));
function withProjects({ active, status } = {}) {
  cfg.projects = [
    { name: 'alpha', projectDir: join(FIX, 'alpha'), plansDir: 'plans', progressPath: 'plans/journal.md' },
    { name: 'beta', projectDir: join(FIX, 'beta'), plansDir: 'plans' },
  ];
  mkdirSync(cfg.stateDir, { recursive: true });
  if (active) writeFileSync(join(cfg.stateDir, 'active.json'), JSON.stringify(active));
  if (status) writeFileSync(join(cfg.stateDir, 'state.json'), JSON.stringify({ status, reason: '' }));
}
const ALPHA_B = { projectDir: join(FIX, 'alpha'), planPath: 'plans/2026-02-b.md', progressPath: 'plans/journal.md' };

test('GET /api/projects: все проекты, активный со статусом и текущим планом', async () => {
  withProjects({ active: ALPHA_B, status: 'running' });
  await start();
  const list = await json(await get('/api/projects'));
  assert.deepEqual(list.map(p => p.name), ['alpha', 'beta']);
  const [alpha, beta] = list;
  assert.equal(alpha.active, true);
  assert.equal(alpha.status, 'running');
  assert.equal(alpha.projectDir, join(FIX, 'alpha'));
  assert.equal(alpha.currentPlan, 'plans/2026-02-b.md');
  assert.deepEqual(alpha.plans.map(p => p.planPath), ['plans/2026-03-empty.md', 'plans/2026-02-b.md', 'plans/2026-01-a.md']);
  assert.deepEqual(alpha.plans[1], { planPath: 'plans/2026-02-b.md', progressPath: 'plans/journal.md', done: 1, total: 3, finished: false });
  assert.equal(beta.active, false);
  assert.equal(beta.status, null);
  assert.equal(beta.currentPlan, 'plans/other.md');
});

test('POST /api/chat с @проектом: Claude получает служебный блок, в истории — текст без него', async () => {
  withProjects({ active: ALPHA_B, status: 'idle' });
  const argvFile = join(root, 'argv.json');
  process.env.FAKE_ARGV = argvFile;
  await start();
  assert.equal((await post('/api/chat', { text: 'что с @beta и @beta?' })).status, 202);
  await idle();
  const argv = JSON.parse(readFileSync(argvFile, 'utf8'));
  const prompt = argv[argv.indexOf('-p') + 1];
  assert.equal(prompt, `что с @beta и @beta?\n\n[Проекты из сообщения]\n- @beta: projectDir=${join(FIX, 'beta')}, план=plans/other.md, прогресс=plans/other.progress.md, автопилот: не активен`);
  const h = await json(await get('/api/history'));
  assert.equal(h.entries[0].text, 'что с @beta и @beta?');
});

test('POST /api/chat без упоминаний: промпт — ровно текст', async () => {
  const argvFile = join(root, 'argv.json');
  process.env.FAKE_ARGV = argvFile;
  await start();
  await post('/api/chat', { text: 'почта a@x.ru' });
  await idle();
  const argv = JSON.parse(readFileSync(argvFile, 'utf8'));
  assert.equal(argv[argv.indexOf('-p') + 1], 'почта a@x.ru');
});

test('GET /api/projects без projects в конфиге → один активный проект', async () => {
  await start();
  const list = await json(await get('/api/projects'));
  assert.equal(list.length, 1);
  assert.equal(list[0].active, true);
  assert.equal(list[0].currentPlan, 'plan.md');
  assert.equal(list[0].status, 'idle');
});

test('GET /api/plan: активный план из active.json, план по проекту, чужие пути → 404', async () => {
  withProjects({ active: ALPHA_B });
  await start();
  let p = await json(await get('/api/plan'));
  assert.equal(p.path, join(FIX, 'alpha', 'plans', '2026-02-b.md'));
  assert.equal(p.done, 1);
  assert.equal(p.total, 3);
  p = await json(await get(`/api/plan?project=beta&plan=${encodeURIComponent('plans/other.md')}`));
  assert.equal(p.path, join(FIX, 'beta', 'plans', 'other.md'));
  assert.equal(p.total, 1);
  for (const q of [
    `project=alpha&plan=${encodeURIComponent('../../etc/passwd')}`,
    `project=alpha&plan=${encodeURIComponent(join(FIX, 'alpha', 'plans', '2026-01-a.md'))}`,
    `project=alpha&plan=${encodeURIComponent('plans/other.md')}`,
    `project=alpha&plan=${encodeURIComponent('plans/journal.md')}`,
    `project=nope&plan=${encodeURIComponent('plans/other.md')}`,
    'project=alpha',
  ]) assert.equal((await get(`/api/plan?${q}`)).status, 404, q);
});

test('GET /api/status читает active.json', async () => {
  withProjects({ active: ALPHA_B, status: 'paused' });
  await start();
  const s = await json(await get('/api/status'));
  assert.match(s.text, /Прогресс: 1\/3/);
});

test('POST /api/switch: после задачи при running, сразу иначе; 409 на выполненный, 404 на чужой путь', async () => {
  withProjects({ active: ALPHA_B, status: 'running' });
  await start();
  let r = await post('/api/switch', { project: 'beta', plan: 'plans/other.md' });
  assert.equal(r.status, 200);
  assert.deepEqual(await json(r), { ok: true, when: 'after-task' });
  const req = JSON.parse(readFileSync(join(cfg.stateDir, 'switch.json'), 'utf8'));
  assert.deepEqual(req, { projectDir: join(FIX, 'beta'), planPath: 'plans/other.md', progressPath: 'plans/other.progress.md' });

  writeFileSync(join(cfg.stateDir, 'state.json'), JSON.stringify({ status: 'done' }));
  r = await post('/api/switch', { project: 'alpha', plan: 'plans/2026-03-empty.md' });
  assert.deepEqual(await json(r), { ok: true, when: 'now' });
  assert.equal(JSON.parse(readFileSync(join(cfg.stateDir, 'switch.json'), 'utf8')).planPath, 'plans/2026-03-empty.md');

  r = await post('/api/switch', { project: 'alpha', plan: 'plans/2026-01-a.md' });
  assert.equal(r.status, 409);
  assert.equal((await json(r)).error, 'План уже выполнен');
  for (const body of [
    { project: 'alpha', plan: '../../etc/passwd' },
    { project: 'alpha', plan: join(FIX, 'beta', 'plans', 'other.md') },
    { project: 'alpha', plan: 'plans/other.md' },
    { project: 'nope', plan: 'plans/other.md' },
    { project: 1, plan: null },
  ]) assert.equal((await post('/api/switch', body)).status, 404, JSON.stringify(body));
  assert.equal(JSON.parse(readFileSync(join(cfg.stateDir, 'switch.json'), 'utf8')).planPath, 'plans/2026-03-empty.md');
});

test('GET /api/status returns statusText and state', async () => {
  mkdirSync(cfg.stateDir, { recursive: true });
  writeFileSync(join(cfg.stateDir, 'state.json'), JSON.stringify({ status: 'paused', reason: 'Пауза по команде с телефона' }));
  await start();
  const s = await json(await get('/api/status'));
  assert.equal(s.state.status, 'paused');
  assert.match(s.text, /Статус: paused — Пауза по команде с телефона/);
  assert.match(s.text, /Прогресс: \d+\/\d+/);
});

test('POST /api/command publishes пауза/продолжить with the bearer token', async () => {
  await start();
  let r = await post('/api/command', { cmd: 'pause' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  r = await post('/api/command', { cmd: 'resume' });
  assert.deepEqual(await r.json(), { ok: true });
  assert.deepEqual(published.map(p => [p.method, p.url, p.auth, p.body]), [
    ['POST', '/topic-cmd', 'Bearer tok-cmd', 'пауза'],
    ['POST', '/topic-cmd', 'Bearer tok-cmd', 'продолжить'],
  ]);
  assert.equal((await post('/api/command', { cmd: 'rm -rf' })).status, 400);
  assert.equal(published.length, 2);
});

test('command: предупреждение при выключенных ntfyCommands', async () => {
  cfg.ntfyCommands = false;
  await start();
  const r = await post('/api/command', { cmd: 'pause' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    ok: true,
    warning: 'У автопилота выключены команды (ntfyCommands) — команду никто не выполнит',
  });
  assert.equal(published.length, 1);
});

test('history: не больше 1 МБ', async () => {
  const dir = join(cfg.stateDir, 'web');
  mkdirSync(dir, { recursive: true });
  const lines = [];
  for (let i = 0; i < 500; i++) {
    lines.push(JSON.stringify({ role: i % 2 ? 'assistant' : 'user', text: `#${i} ` + 'я'.repeat(50 * 1024), at: '2026-10-21T00:00:00.000Z' }));
  }
  writeFileSync(join(dir, 'history.jsonl'), lines.join('\n') + '\n');
  await start();
  const r = await get('/api/history');
  const body = Buffer.from(await r.arrayBuffer());
  assert.ok(body.length < 1_048_576, `${body.length} bytes`);
  const { entries } = JSON.parse(body.toString('utf8'));
  assert.ok(entries.length > 0);
  assert.ok(entries.at(-1).text.startsWith('#499 '));
  for (const e of entries) assert.equal(e.text.length, `#${e.text.slice(1, e.text.indexOf(' '))} `.length + 50 * 1024);
});

test('POST /api/command reports failure when ntfy is not reachable', async () => {
  cfg.ntfyServer = 'http://127.0.0.1:1';
  await start();
  const r = await post('/api/command', { cmd: 'pause' });
  assert.equal(r.status, 502);
  assert.equal((await r.json()).ok, false);
});

test('startup kills an orphaned answer process and is not busy', async () => {
  const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
  orphan.unref();
  await waitFor(() => alive(orphan.pid));
  mkdirSync(join(cfg.stateDir, 'web'), { recursive: true });
  writeFileSync(join(cfg.stateDir, 'web', 'child.pid'), pidRecord(orphan.pid));
  await start();
  await waitFor(() => !alive(orphan.pid));
  const h = await json(await get('/api/history'));
  assert.equal(h.busy, false);
  process.env.FAKE_STREAM = 'ok';
  assert.equal((await post('/api/chat', { text: 'привет' })).status, 202);
  await idle();
});

test('the real panel page: three tabs, relative markdown.mjs, no absolute /api paths', async () => {
  srv = await startServer(cfg, { port: 0, claudeBin: fake });
  base = `http://127.0.0.1:${srv.port}`;
  const res = await get('/');
  assert.equal(res.status, 200);
  const html = await res.text();
  for (const tab of ['Чат', 'План', 'Статус']) assert.match(html, new RegExp(`<button data-tab="[a-z]+"[^>]*>(?:(?!</button>).)*${tab}</button>`));
  assert.match(html, /from ['"]\.\/markdown\.mjs['"]/);
  assert.match(html, /['"`]api\/(history|chat|events|stop|reset|plan|status|command)/);
  assert.doesNotMatch(html, /['"`(]\/api/);
  assert.doesNotMatch(html, /(src|href|action)=["']\//);
  assert.doesNotMatch(html, /\.innerHTML\s*=(?!\s*(?:renderMarkdown\(|''|""|``))/);
  // Without an inline icon the browser asks for /favicon.ico and logs a 404 on every load.
  assert.match(html, /<link rel="icon" href="data:/);
  // parsePlan's phase is already "Этап N": prefixing it again shows "Этап Этап 1".
  assert.doesNotMatch(html, /`Этап \$\{/);
});

// A tiny but real PNG header plus filler: the server checks the Content-Type, not the pixels.
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('картинка')]);
const upload = (body, type = 'image/png') => fetch(base + '/api/upload', { method: 'POST', headers: { 'Content-Type': type }, body });
const rawGet = path => new Promise((ok, fail) => {
  const sock = connect(srv.port, '127.0.0.1', () => sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
  let data = '';
  sock.on('data', c => { data += c; });
  sock.on('end', () => ok(data));
  sock.on('error', fail);
});

test('upload: PNG → id, GET /uploads/<id> отдаёт те же байты; не картинка → 400; 9 МБ → 413', async () => {
  await start();
  const r = await upload(PNG);
  assert.equal(r.status, 200);
  const { id } = await json(r);
  assert.match(id, /^[0-9a-f-]{36}\.png$/);
  const img = await get(`/uploads/${id}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
  assert.equal((await upload(PNG, 'image/jpeg; charset=binary')).status, 200);
  assert.equal((await upload('hello', 'text/plain')).status, 400);
  assert.equal((await upload(PNG, 'image/svg+xml')).status, 400);
  assert.equal((await upload(Buffer.alloc(9 * 1024 * 1024))).status, 413);
});

test('upload: чужие пути и расширения в /uploads → 404', async () => {
  mkdirSync(cfg.stateDir, { recursive: true });
  writeFileSync(join(cfg.stateDir, 'state.json'), '{"status":"idle"}');
  await start();
  assert.match(await rawGet('/uploads/../state.json'), /^HTTP\/1\.1 404/);
  for (const path of [
    '/uploads/..%2Fstate.json',
    '/uploads/abc.exe',
    `/uploads/${'0'.repeat(36)}.exe`,
    `/uploads/${'0'.repeat(36)}.png`,
    '/uploads/',
  ]) assert.equal((await get(path)).status, 404, path);
});

test('chat с картинкой без текста: путь в -p, images в истории; 6 картинок или чужой id → 400', async () => {
  const argvFile = join(root, 'argv.json');
  process.env.FAKE_ARGV = argvFile;
  await start();
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push((await json(await upload(PNG))).id);
  assert.equal((await post('/api/chat', { images: ids })).status, 400);
  assert.equal((await post('/api/chat', { images: [`${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}.png`] })).status, 400);
  assert.equal((await post('/api/chat', { images: ['../state.json'] })).status, 400);
  assert.equal((await post('/api/chat', { images: 'x' })).status, 400);
  assert.equal((await post('/api/chat', { images: [] })).status, 400);
  assert.equal((await post('/api/chat', { images: [ids[0]] })).status, 202);
  await idle();
  const argv = JSON.parse(readFileSync(argvFile, 'utf8'));
  assert.equal(argv[argv.indexOf('-p') + 1], `Вложения (открой инструментом Read):\n- ${join(cfg.stateDir, 'web', 'uploads', ids[0])}`);
  const h = await json(await get('/api/history'));
  assert.equal(h.entries[0].role, 'user');
  assert.equal(h.entries[0].text, '');
  assert.deepEqual(h.entries[0].images, [ids[0]]);
});

test('chat: текст, @проект и картинки — всё в промпте, в истории текст и images', async () => {
  withProjects({ active: ALPHA_B, status: 'idle' });
  const argvFile = join(root, 'argv.json');
  process.env.FAKE_ARGV = argvFile;
  await start();
  const a = (await json(await upload(PNG))).id;
  const b = (await json(await upload(PNG, 'image/webp'))).id;
  assert.equal((await post('/api/chat', { text: 'смотри @beta', images: [a, b] })).status, 202);
  await idle();
  const argv = JSON.parse(readFileSync(argvFile, 'utf8'));
  const dir = join(cfg.stateDir, 'web', 'uploads');
  assert.equal(argv[argv.indexOf('-p') + 1], `смотри @beta\n\n[Проекты из сообщения]\n- @beta: projectDir=${join(FIX, 'beta')}, план=plans/other.md, прогресс=plans/other.progress.md, автопилот: не активен\n\nВложения (открой инструментом Read):\n- ${join(dir, a)}\n- ${join(dir, b)}`);
  const h = await json(await get('/api/history'));
  assert.equal(h.entries[0].text, 'смотри @beta');
  assert.deepEqual(h.entries[0].images, [a, b]);
});

test('uploads: хранятся последние 200, reset очищает папку', async () => {
  await start();
  const dir = join(cfg.stateDir, 'web', 'uploads');
  const first = (await json(await upload(PNG))).id;
  mkdirSync(dir, { recursive: true });
  // Older files than the real upload, so pruning drops these and the first upload survives the cut.
  const old = new Date(Date.now() - 3600_000);
  for (let i = 0; i < 205; i++) {
    const f = join(dir, `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000.png`);
    writeFileSync(f, 'x');
    utimesSync(f, old, old);
  }
  await upload(PNG);
  assert.equal(readdirSync(dir).length, 200);
  assert.ok(existsSync(join(dir, first)));
  assert.equal((await post('/api/reset')).status, 200);
  assert.deepEqual(readdirSync(dir), []);
  assert.equal((await get(`/uploads/${first}`)).status, 404);
});

test('a malformed request URL gets 400 and does not bring the server down', async () => {
  await start();
  const reply = await new Promise((ok, fail) => {
    const sock = connect(srv.port, '127.0.0.1', () => sock.write('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    let data = '';
    sock.on('data', c => { data += c; });
    sock.on('end', () => ok(data));
    sock.on('error', fail);
  });
  assert.match(reply, /^HTTP\/1\.1 400/);
  assert.equal((await get('/api/history')).status, 200);
});
