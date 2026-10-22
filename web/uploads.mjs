// Uploaded images (<stateDir>/web/uploads/<uuid>.<ext>), served by the panel at GET /uploads/<id>.
import { mkdirSync, readdirSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const MAX_UPLOAD = 8 * 1024 * 1024;
export const KEEP_UPLOADS = 200;

// Stores the image under a fresh id, keeps the KEEP_UPLOADS newest, returns the id.
export function saveUpload(dir, ext, body) {
  const id = `${randomUUID()}.${ext}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, id), body);
  pruneUploads(dir, KEEP_UPLOADS);
  return id;
}

// Keeps the `keep` newest uploads.
function pruneUploads(dir, keep) {
  const files = readdirSync(dir).flatMap(name => {
    try { return [{ name, mtime: statSync(join(dir, name)).mtimeMs }]; } catch { return []; }
  });
  files.sort((a, b) => b.mtime - a.mtime);
  for (const { name } of files.slice(keep)) rmSync(join(dir, name), { force: true });
}
