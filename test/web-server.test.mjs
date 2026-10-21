import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
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
