import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { notify, stopMessage, buttonsFor } from '../lib/notify.mjs';
import { parseCommand } from '../lib/commands.mjs';

// A local stand-in for ntfy that records every POST.
export async function fakeNtfy() {
  const got = [];
  const auth = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', d => (body += d)).on('end', () => {
      const url = new URL(req.url, 'http://x');
      got.push({ method: req.method, path: url.pathname, params: Object.fromEntries(url.searchParams), body });
      auth.push(req.headers.authorization);
      res.end('{}');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, got, auth, close: () => server.close() };
}

test('notify posts the message to <server>/<topic> with title, tags and priority as params', async () => {
  const n = await fakeNtfy();
  const ok = await notify({ ntfyServer: n.url, ntfyTopic: 'secret-topic' }, { title: 'Готово', message: 'Все задачи', tags: 'white_check_mark', priority: 4 });
  n.close();
  assert.equal(ok, true);
  assert.equal(n.got.length, 1);
  assert.deepEqual(n.got[0], { method: 'POST', path: '/secret-topic', params: { title: 'Готово', tags: 'white_check_mark', priority: '4' }, body: 'Все задачи' });
});

test('notify without a topic does nothing', async () => {
  assert.equal(await notify({}, { title: 't', message: 'm' }), false);
});

test('notify never throws when the server is unreachable', async () => {
  assert.equal(await notify({ ntfyServer: 'http://127.0.0.1:1', ntfyTopic: 't' }, { title: 't', message: 'm' }), false);
});

test('stopMessage describes each stop status', () => {
  assert.match(stopMessage('done', 'x').title, /готово/i);
  assert.equal(stopMessage('done', 'x').priority, 4);
  assert.match(stopMessage('waiting-user', 'Ручная задача: EAS').message, /Ручная задача: EAS/);
  assert.match(stopMessage('halted', 'Task 5 не удалась 3 раз подряд').title, /застрял/i);
  assert.match(stopMessage('auth', 'r').title, /вход/i);
  assert.match(stopMessage('paused', 'Этап завершён').title, /пауза/i);
});

test('notify sends ntfyToken as a Bearer token', async () => {
  const n = await fakeNtfy();
  await notify({ ntfyServer: n.url, ntfyTopic: 't', ntfyToken: 'tk_abc' }, { title: 't', message: 'm' });
  await notify({ ntfyServer: n.url, ntfyTopic: 't' }, { title: 't', message: 'm' });
  n.close();
  assert.deepEqual(n.auth, ['Bearer tk_abc', undefined]);
});

const cmdCfg = url => ({ ntfyServer: url, ntfyTopic: 'tp', ntfyCommands: true, ntfyCommandToken: 'tk_phone' });

test('notify with actions sends ntfy http buttons that post the command to <topic>-cmd', async () => {
  const n = await fakeNtfy();
  await notify(cmdCfg(n.url), { title: 't', message: 'm', actions: [{ label: 'Продолжить', command: 'resume' }, { label: 'Статус', command: 'status' }] });
  n.close();
  assert.equal(n.got[0].params.actions, [
    `http, Продолжить, ${n.url}/tp-cmd, method=POST, body=resume, headers.Authorization=Bearer tk_phone`,
    `http, Статус, ${n.url}/tp-cmd, method=POST, body=status, headers.Authorization=Bearer tk_phone`,
  ].join('; '));
});

test('notify sends no actions without ntfyCommandToken or ntfyCommands', async () => {
  const n = await fakeNtfy();
  const actions = [{ label: 'Статус', command: 'status' }];
  await notify({ ...cmdCfg(n.url), ntfyCommandToken: undefined }, { title: 't', message: 'm', actions });
  await notify({ ...cmdCfg(n.url), ntfyCommands: false }, { title: 't', message: 'm', actions });
  await notify(cmdCfg(n.url), { title: 't', message: 'm', actions: [] });
  n.close();
  assert.equal(n.got.length, 3);
  for (const g of n.got) assert.equal(g.params.actions, undefined);
});

test('buttonsFor gives each notification kind its buttons, never more than 3', () => {
  assert.deepEqual(buttonsFor('halted'), [{ label: 'Продолжить', command: 'resume' }, { label: 'Статус', command: 'status' }]);
  assert.deepEqual(buttonsFor('waiting-user'), buttonsFor('halted'));
  assert.deepEqual(buttonsFor('done'), [{ label: 'Статус', command: 'status' }]);
  assert.deepEqual(buttonsFor('auth'), [{ label: 'Продолжить', command: 'resume' }]);
  assert.deepEqual(buttonsFor('paused'), [{ label: 'Продолжить', command: 'resume' }]);
  assert.deepEqual(buttonsFor('limit'), [{ label: 'Продолжить сейчас', command: 'resume' }]);
  assert.deepEqual(buttonsFor('task'), [{ label: 'Пауза', command: 'pause' }]);
  for (const k of ['done', 'waiting-user', 'halted', 'auth', 'paused', 'limit', 'task']) assert.ok(buttonsFor(k).length <= 3, k);
});

test('every button command is understood by parseCommand', () => {
  for (const k of ['done', 'waiting-user', 'halted', 'auth', 'paused', 'limit', 'task']) {
    for (const b of buttonsFor(k)) assert.notEqual(parseCommand(b.command), null, b.command);
  }
});
