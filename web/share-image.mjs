#!/usr/bin/env node
// Lets the planner show an image in the panel chat: copies it into the uploads and prints the
// Markdown line to paste into the answer. Usage: node web/share-image.mjs <path> "<caption>"
import { readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { loadConfig } from './server.mjs';
import { MAX_UPLOAD, saveUpload } from './uploads.mjs';

const EXTENSIONS = { '.jpg': 'jpg', '.jpeg': 'jpg', '.png': 'png', '.webp': 'webp', '.gif': 'gif' };

function fail(message) {
  console.error(message);
  process.exit(1);
}

const [file, caption = ''] = process.argv.slice(2);
if (!file) fail('Использование: node web/share-image.mjs <путь> "<подпись>"');
const ext = EXTENSIONS[extname(file).toLowerCase()];
if (!ext) fail('Только картинки: JPEG, PNG, WebP, GIF');
let size;
try { size = statSync(file).size; } catch { fail(`Нет файла: ${file}`); }
if (size > MAX_UPLOAD) fail(`Картинка больше ${MAX_UPLOAD / 1024 / 1024} МБ`);
if (!size) fail('Пустой файл');

const id = saveUpload(join(loadConfig().stateDir, 'web', 'uploads'), ext, readFileSync(file));
console.log(`![${caption.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim()}](uploads/${id})`);
