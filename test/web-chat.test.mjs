import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChat } from '../web/chat.mjs';

const fake = fileURLToPath(new URL('./fixtures/fake-claude-stream.mjs', import.meta.url));
chmodSync(fake, 0o755);
const promptFile = fileURLToPath(new URL('../web/planner-prompt.md', import.meta.url));
const ANSWER = 'Привет.\n\nЭто планировщик.\n\nЧем помочь?';
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

let root, dir, argvFile;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ap-chat-'));
  dir = join(root, 'web');
  argvFile = join(root, 'argv.json');
  process.env.FAKE_ARGV = argvFile;
  process.env.FAKE_STREAM = 'ok';
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const make = () => createChat({ cfg: { autopilotDir: root }, dir, claudeBin: fake });
const argv = () => JSON.parse(readFileSync(argvFile, 'utf8'));
const roles = chat => chat.history().map(e => e.role);
const session = () => JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));

async function sendCollect(chat, text) {
  const events = [];
  await chat.send(text, e => events.push(e));
  return events;
}

test('ok: three deltas then done, history and session saved', async () => {
  const chat = make();
  const events = await sendCollect(chat, 'привет');
  assert.deepEqual(events.map(e => e.type), ['delta', 'delta', 'delta', 'done']);
  assert.equal(events.slice(0, 3).map(e => e.text).join(''), ANSWER);
  assert.equal(events[3].text, ANSWER);
  assert.deepEqual(roles(chat), ['user', 'assistant']);
  assert.equal(chat.history()[0].text, 'привет');
  assert.equal(chat.history()[1].text, ANSWER);
  assert.ok(chat.history()[0].at);
  assert.match(session().sessionId, /^sess-\d+$/);
  assert.equal(chat.busy(), false);
});

test('separate assistant messages (text around tool calls) are split by a blank line, so markdown survives', async () => {
  process.env.FAKE_PARTS = JSON.stringify(['Сейчас посмотрю план.', '## Итог\n- готово']);
  try {
    const events = await sendCollect(make(), 'что в плане?');
    const want = 'Сейчас посмотрю план.\n\n## Итог\n- готово';
    assert.equal(events.filter(e => e.type === 'delta').map(e => e.text).join(''), want);
    assert.equal(events.at(-1).text, want);
  } finally {
    delete process.env.FAKE_PARTS;
  }
});

test('history survives a new chat instance (read from history.jsonl)', async () => {
  await sendCollect(make(), 'привет');
  assert.deepEqual(roles(make()), ['user', 'assistant']);
});

test('spawn args: stream-json, permission mode, settings, planner prompt, no resume first', async () => {
  await sendCollect(make(), 'привет');
  const a = argv();
  assert.equal(a[a.indexOf('-p') + 1], 'привет');
  assert.equal(a[a.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(a.includes('--verbose'));
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(a[a.indexOf('--settings') + 1], join(root, 'claude-settings.json'));
  assert.equal(a[a.indexOf('--append-system-prompt') + 1], readFileSync(promptFile, 'utf8'));
  assert.equal(a.includes('--resume'), false);
});

test('second message resumes the saved session', async () => {
  const chat = make();
  await sendCollect(chat, 'раз');
  const id = session().sessionId;
  await sendCollect(chat, 'два');
  const a = argv();
  assert.equal(a[a.indexOf('--resume') + 1], id);
  assert.deepEqual(roles(chat), ['user', 'assistant', 'user', 'assistant']);
});

test('busy during slow answer; second send throws busy', async () => {
  process.env.FAKE_STREAM = 'slow';
  const chat = make();
  const p = chat.send('долго', () => {});
  assert.equal(chat.busy(), true);
  await assert.rejects(chat.send('ещё', () => {}), { message: 'busy' });
  assert.throws(() => chat.reset(), { message: 'busy' });
  await p;
  assert.equal(chat.busy(), false);
  assert.deepEqual(roles(chat), ['user', 'assistant']);
});

test('answer is saved even if the listener throws (client gone)', async () => {
  process.env.FAKE_STREAM = 'slow';
  const chat = make();
  await chat.send('долго', () => { throw new Error('socket closed'); });
  assert.deepEqual(roles(chat), ['user', 'assistant']);
  assert.equal(chat.history()[1].text, ANSWER);
});

test('stop during slow kills the process and records "остановлено"', async () => {
  process.env.FAKE_STREAM = 'slow';
  const chat = make();
  const events = [];
  const p = chat.send('долго', e => events.push(e));
  await new Promise(r => setTimeout(r, 400));
  const pid = Number(readFileSync(join(dir, 'child.pid'), 'utf8').split(' ')[0]);
  chat.stop();
  await p;
  assert.equal(alive(pid), false);
  assert.equal(chat.busy(), false);
  assert.deepEqual(roles(chat), ['user', 'error']);
  assert.match(chat.history()[1].text, /остановлено/i);
  assert.equal(events.at(-1).type, 'error');
  assert.equal(existsSync(join(dir, 'child.pid')), false);
});

test('badresume: error in history, session dropped, next send starts fresh', async () => {
  const chat = make();
  writeFileSync(join(dir, 'session.json'), JSON.stringify({ sessionId: 'gone' }));
  process.env.FAKE_STREAM = 'badresume';
  const events = await sendCollect(chat, 'привет');
  assert.equal(events.at(-1).type, 'error');
  assert.deepEqual(roles(chat), ['user', 'error']);
  assert.match(chat.history()[1].text, /новый разговор/i);
  assert.equal(existsSync(join(dir, 'session.json')), false);
  await sendCollect(chat, 'ещё раз');
  assert.equal(argv().includes('--resume'), false);
  assert.deepEqual(roles(chat), ['user', 'error', 'user', 'assistant']);
});

test('limit: error entry carries the limit text', async () => {
  process.env.FAKE_STREAM = 'limit';
  const chat = make();
  const events = await sendCollect(chat, 'привет');
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).text, /usage limit/);
  assert.deepEqual(roles(chat), ['user', 'error']);
  assert.match(chat.history()[1].text, /usage limit/);
});

test('missing binary: error entry, not busy, no crash', async () => {
  const chat = createChat({ cfg: { autopilotDir: root }, dir, claudeBin: join(root, 'no-such-claude') });
  const events = await sendCollect(chat, 'привет');
  assert.equal(events.at(-1).type, 'error');
  assert.deepEqual(roles(chat), ['user', 'error']);
  assert.equal(chat.busy(), false);
});

test('history is trimmed to the last 500 entries', async () => {
  const chat = make();
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: 499 }, (_, i) => JSON.stringify({ role: 'user', text: `m${i}`, at: 'x' }));
  writeFileSync(join(dir, 'history.jsonl'), lines.join('\n') + '\n');
  await sendCollect(chat, 'последнее');
  const h = chat.history();
  assert.equal(h.length, 500);
  assert.equal(h[0].text, 'm1');
  assert.equal(h.at(-1).role, 'assistant');
  assert.equal(readFileSync(join(dir, 'history.jsonl'), 'utf8').trim().split('\n').length, 500);
});

test('reset clears history and session', async () => {
  const chat = make();
  await sendCollect(chat, 'привет');
  chat.reset();
  assert.deepEqual(chat.history(), []);
  assert.equal(existsSync(join(dir, 'session.json')), false);
  await sendCollect(chat, 'снова');
  assert.equal(argv().includes('--resume'), false);
});

test('send: исключение до запуска снимает занятость', async () => {
  const chat = createChat({ cfg: { autopilotDir: root }, dir, claudeBin: fake, promptFile: join(root, 'no-such-prompt.md') });
  await assert.rejects(chat.send('привет', () => {}));
  assert.equal(chat.busy(), false);
  await assert.rejects(chat.send('ещё', () => {}), err => err.message !== 'busy');
  assert.equal(chat.busy(), false);
});

test('stop: таймер SIGKILL снимается после выхода', async () => {
  process.env.FAKE_STREAM = 'termlate';
  const signals = [];
  const kill = (pid, signal) => { signals.push(signal); process.kill(pid, signal); };
  const chat = createChat({ cfg: { autopilotDir: root }, dir, claudeBin: fake, killGraceMs: 300, kill });
  const p = chat.send('долго', () => {});
  await new Promise(r => setTimeout(r, 300));
  chat.stop();
  await p;
  await new Promise(r => setTimeout(r, 500));
  assert.ok(signals.includes('SIGTERM'));
  assert.equal(signals.includes('SIGKILL'), false);
});

test('stop после готового result не выбрасывает ответ', async () => {
  process.env.FAKE_STREAM = 'linger';
  const chat = make();
  let gotDelta;
  const delta = new Promise(r => { gotDelta = r; });
  const p = chat.send('привет', e => { if (e.type === 'delta') gotDelta(); });
  await delta;
  await new Promise(r => setTimeout(r, 300));
  chat.stop();
  await p;
  assert.deepEqual(roles(chat), ['user', 'assistant']);
  assert.equal(chat.history()[1].text, ANSWER);
});

test('прерванный ответ отмечается при создании чата', async () => {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'history.jsonl'), JSON.stringify({ role: 'user', text: 'привет', at: 'x' }) + '\n');
  writeFileSync(join(dir, 'child.pid'), '999999999 dead-boot 1');
  const chat = make();
  assert.deepEqual(roles(chat), ['user', 'error']);
  assert.equal(chat.history()[1].text, 'Ответ прерван перезапуском пульта.');
  assert.deepEqual(roles(make()), ['user', 'error']);
});
