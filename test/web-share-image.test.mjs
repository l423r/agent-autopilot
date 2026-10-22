import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../web/share-image.mjs', import.meta.url));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

let root, uploads, config;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ap-share-'));
  uploads = join(root, 'state', 'web', 'uploads');
  config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ projectDir: root, planPath: 'plan.md', stateDir: join(root, 'state') }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const share = (...args) => spawnSync(process.execPath, [script, ...args], {
  encoding: 'utf8', env: { ...process.env, AUTOPILOT_CONFIG: config },
});

test('share-image: копирует картинку в загрузки и печатает Markdown-строку', () => {
  const src = join(root, 'preview.png');
  writeFileSync(src, PNG);
  const r = share(src, 'Подпись');
  assert.equal(r.status, 0, r.stderr);
  const files = readdirSync(uploads);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[0-9a-f-]{36}\.png$/);
  assert.deepEqual(readFileSync(join(uploads, files[0])), PNG);
  assert.equal(r.stdout, `![Подпись](uploads/${files[0]})\n`);
});

test('share-image: .JPEG сохраняется как .jpg — такие пути понимает пульт', () => {
  const src = join(root, 'Shot.JPEG');
  writeFileSync(src, PNG);
  const r = share(src, 'Снимок');
  assert.equal(r.status, 0, r.stderr);
  const [name] = readdirSync(uploads);
  assert.match(name, /^[0-9a-f-]{36}\.jpg$/);
  assert.equal(r.stdout, `![Снимок](uploads/${name})\n`);
});

test('share-image: скобки и переводы строк в подписи не ломают Markdown', () => {
  const src = join(root, 'p.png');
  writeFileSync(src, PNG);
  const r = share(src, 'Иконка [v2]\nтёмная');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^!\[Иконка v2 тёмная\]\(uploads\/[0-9a-f-]{36}\.png\)\n$/);
});

test('share-image: не картинка, пустой и слишком большой файл — код 1 и сообщение', () => {
  const txt = join(root, 'notes.txt');
  writeFileSync(txt, 'x');
  const big = join(root, 'big.png');
  writeFileSync(big, Buffer.alloc(8 * 1024 * 1024 + 1));
  const empty = join(root, 'empty.png');
  writeFileSync(empty, '');
  for (const [args, msg] of [
    [[txt, 'x'], /JPEG, PNG, WebP, GIF/],
    [[big, 'x'], /больше 8 МБ/],
    [[empty, 'x'], /Пустой файл/],
    [[join(root, 'missing.png'), 'x'], /Нет файла/],
    [[], /share-image\.mjs <путь> "<подпись>"/],
  ]) {
    const r = share(...args);
    assert.equal(r.status, 1, `${args}: ${r.stdout}`);
    assert.match(r.stderr, msg);
    assert.equal(r.stdout, '');
  }
  assert.ok(!existsSync(uploads) || readdirSync(uploads).length === 0);
});

test('share-image: оставляет только 200 новейших загрузок, как /api/upload', () => {
  mkdirSync(uploads, { recursive: true });
  const old = new Date(Date.now() - 3600_000);
  for (let i = 0; i < 200; i++) {
    const name = `00000000-0000-0000-0000-${String(i).padStart(12, '0')}.png`;
    writeFileSync(join(uploads, name), PNG);
    utimesSync(join(uploads, name), old, new Date(old.getTime() + i * 1000));
  }
  const src = join(root, 'p.png');
  writeFileSync(src, PNG);
  const r = share(src, 'x');
  assert.equal(r.status, 0, r.stderr);
  const files = readdirSync(uploads);
  assert.equal(files.length, 200);
  assert.ok(!files.includes('00000000-0000-0000-0000-000000000000.png'), 'самая старая удалена');
  assert.ok(files.some(f => r.stdout.includes(f)), 'новая на месте');
});

test('правила: планировщик показывает картинки через share-image (planner-prompt и README)', () => {
  const prompt = readFileSync(fileURLToPath(new URL('../web/planner-prompt.md', import.meta.url)), 'utf8');
  assert.match(prompt, /показать пользователю картинку.*`node \/root\/agent-autopilot\/web\/share-image\.mjs <путь> "<подпись>"`.*как есть/);
  const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
  assert.match(readme, /web\/share-image\.mjs/);
});
