import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { notify, stopMessage } from '../lib/notify.mjs';

// A local stand-in for ntfy that records every POST.
export async function fakeNtfy() {
  const got = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', d => (body += d)).on('end', () => {
      const url = new URL(req.url, 'http://x');
      got.push({ method: req.method, path: url.pathname, params: Object.fromEntries(url.searchParams), body });
      res.end('{}');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, got, close: () => server.close() };
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
