import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { subscribeCommands } from '../lib/listen.mjs';

// A local stand-in for ntfy's streaming JSON endpoint. Each incoming request is handed
// to the next scripted handler (the last one repeats); every request is recorded.
async function fakeStream(handlers) {
  const reqs = [];
  const open = new Set();
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    reqs.push({ path: url.pathname, since: url.searchParams.get('since'), auth: req.headers.authorization, at: Date.now() });
    open.add(res);
    res.on('close', () => open.delete(res));
    handlers[Math.min(reqs.length - 1, handlers.length - 1)](req, res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    reqs,
    open,
    close: () => { for (const r of open) r.destroy(); server.close(); },
  };
}

const line = o => JSON.stringify(o) + '\n';
const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const tempDir = prefix => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d; };
const tmp = () => tempDir('listen-');
const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise(r => setTimeout(r, 10));
  }
};

test('delivers message events, ignores open/keepalive and broken lines', async () => {
  const s = await fakeStream([(req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(line({ id: 'o1', time: 1, event: 'open' }));
    res.write(line({ id: 'k1', time: 2, event: 'keepalive' }));
    res.write('{not json\n');
    res.write(line({ id: 'm1', time: 3, event: 'message', message: 'статус' }).slice(0, 10));
    setTimeout(() => res.write(line({ id: 'm1', time: 3, event: 'message', message: 'статус' }).slice(10)), 20);
  }]);
  const dir = tmp();
  const got = [];
  const sub = subscribeCommands({ ntfyServer: s.url, ntfyTopic: 'top', ntfyToken: 'tk' }, { sinceFile: join(dir, 'commands.since'), onMessage: m => got.push(m), log: () => {} });
  await until(() => got.length === 1);
  await new Promise(r => setTimeout(r, 50));
  sub.stop();
  s.close();
  assert.deepEqual(got, [{ id: 'm1', time: 3, message: 'статус' }]);
  assert.equal(s.reqs[0].path, '/top-cmd/json');
  assert.equal(s.reqs[0].auth, 'Bearer tk');
  assert.equal(readFileSync(join(dir, 'commands.since'), 'utf8').trim(), 'm1');
});

test('reconnects after a drop with since=<last id> and never delivers twice', async () => {
  const s = await fakeStream([
    (req, res) => {
      res.writeHead(200);
      res.write(line({ id: 'a1', time: 1, event: 'message', message: 'пауза' }));
      setTimeout(() => res.destroy(), 30);
    },
    (req, res) => {
      res.writeHead(200);
      // ntfy replays nothing older than since; send the next message only.
      res.write(line({ id: 'a2', time: 2, event: 'message', message: 'дальше' }));
    },
  ]);
  const dir = tmp();
  const got = [];
  const sub = subscribeCommands({ ntfyServer: s.url, ntfyTopic: 't', __retryMs: 20 }, { sinceFile: join(dir, 'since'), onMessage: m => got.push(m.id), log: () => {} });
  await until(() => got.length === 2);
  await new Promise(r => setTimeout(r, 80));
  sub.stop();
  s.close();
  assert.deepEqual(got, ['a1', 'a2']);
  assert.equal(s.reqs[1].since, 'a1');
});

test('uses the stored id from sinceFile on the first request', async () => {
  const s = await fakeStream([(req, res) => res.writeHead(200).write(line({ id: 'x', time: 1, event: 'open' }))]);
  const dir = tmp();
  writeFileSync(join(dir, 'since'), 'stored9\n');
  const sub = subscribeCommands({ ntfyServer: s.url, ntfyTopic: 't' }, { sinceFile: join(dir, 'since'), onMessage: () => {}, log: () => {} });
  await until(() => s.reqs.length === 1);
  sub.stop();
  s.close();
  assert.equal(s.reqs[0].since, 'stored9');
});

test('without a sinceFile the first request starts from now (unix seconds)', async () => {
  const s = await fakeStream([(req, res) => res.writeHead(200).write(line({ id: 'x', time: 1, event: 'open' }))]);
  const before = Math.floor(Date.now() / 1000);
  const sub = subscribeCommands({ ntfyServer: s.url, ntfyTopic: 't' }, { sinceFile: join(tmp(), 'missing'), onMessage: () => {}, log: () => {} });
  await until(() => s.reqs.length === 1);
  sub.stop();
  s.close();
  const since = Number(s.reqs[0].since);
  assert.ok(Number.isInteger(since), `since=${s.reqs[0].since}`);
  assert.ok(since >= before - 1 && since <= before + 2, `since=${since} now=${before}`);
});

test('on 403 logs and retries no sooner than the delay, doubling it', async () => {
  const s = await fakeStream([(req, res) => { res.statusCode = 403; res.end('{"code":40301}'); }]);
  const logs = [];
  const sub = subscribeCommands({ ntfyServer: s.url, ntfyTopic: 't', __retryMs: 50 }, { sinceFile: join(tmp(), 's'), onMessage: () => {}, log: l => logs.push(l) });
  await until(() => s.reqs.length === 3);
  sub.stop();
  s.close();
  assert.ok(s.reqs[1].at - s.reqs[0].at >= 45, `first gap ${s.reqs[1].at - s.reqs[0].at}`);
  assert.ok(s.reqs[2].at - s.reqs[1].at >= 95, `second gap ${s.reqs[2].at - s.reqs[1].at}`);
  assert.ok(logs.length >= 2 && logs.length <= 3, `logs: ${logs.length}`);
  assert.match(logs[0], /403/);
});

test('a successful connection resets the delay', async () => {
  let n = 0;
  const s = await fakeStream([(req, res) => {
    n++;
    if (n === 1 || n === 2) { res.statusCode = 500; return res.end(); }
    if (n === 3) { res.writeHead(200).write(line({ id: 'o', time: 1, event: 'open' })); return setTimeout(() => res.destroy(), 20); }
    res.statusCode = 500; res.end();
  }]);
  const sub = subscribeCommands({ ntfyServer: s.url, ntfyTopic: 't', __retryMs: 40 }, { sinceFile: join(tmp(), 's'), onMessage: () => {}, log: () => {} });
  await until(() => s.reqs.length === 4);
  sub.stop();
  s.close();
  // gaps: 1→2 = 40, 2→3 = 80, 3→4 = 40 again (+20 ms the stream stayed open)
  const gap = s.reqs[3].at - s.reqs[2].at;
  assert.ok(gap < 100, `gap after success ${gap}`);
});

test('stop() closes the connection and stops reconnecting', async () => {
  const s = await fakeStream([(req, res) => res.writeHead(200).write(line({ id: 'o', time: 1, event: 'open' }))]);
  const sub = subscribeCommands({ ntfyServer: s.url, ntfyTopic: 't', __retryMs: 10 }, { sinceFile: join(tmp(), 's'), onMessage: () => {}, log: () => {} });
  await until(() => s.open.size === 1);
  sub.stop();
  await until(() => s.open.size === 0);
  await new Promise(r => setTimeout(r, 100));
  s.close();
  assert.equal(s.reqs.length, 1);
});

test('a throwing onMessage does not kill the subscription', async () => {
  const s = await fakeStream([(req, res) => {
    res.writeHead(200);
    res.write(line({ id: 'b1', time: 1, event: 'message', message: 'x' }));
    res.write(line({ id: 'b2', time: 2, event: 'message', message: 'y' }));
  }]);
  const got = [];
  const sub = subscribeCommands({ ntfyServer: s.url, ntfyTopic: 't' }, { sinceFile: join(tmp(), 's'), onMessage: m => { got.push(m.id); throw new Error('boom'); }, log: () => {} });
  await until(() => got.length === 2);
  sub.stop();
  s.close();
  assert.deepEqual(got, ['b1', 'b2']);
});
