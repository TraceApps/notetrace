/**
 * upload-cleanup.js: deletes uploaded files nothing refers to anymore.
 *
 * Removing an image from a note, or deleting the note, only tombstones the
 * attachment row (so the removal syncs); the file stays in UPLOADS_PATH.
 * Once a day this deletes top-level upload files that no live attachment,
 * recently removed attachment, or avatar points at. Safety margins:
 *   - files younger than MIN_AGE_MS are kept (an upload whose note or
 *     attachment is still being saved, an import mid-way)
 *   - attachments removed within GRACE_DAYS keep their file, so a device
 *     that syncs a restore or an undo still finds it
 *   - subdirectories (backups) and dotfiles are never touched
 * Full backups carry their own copy of the files.
 */
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { logger } from '../logger.js';
import { orphanUploads } from './upload-cleanup-core.js';

const uploadsPath = process.env.UPLOADS_PATH || './uploads';
export const MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const GRACE_DAYS = 30;

function _referencedNames() {
  const cutoff = new Date(Date.now() - GRACE_DAYS * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const urls = [
    ...db.prepare(`SELECT url FROM note_attachments WHERE deleted_at IS NULL OR deleted_at > ?`).all(cutoff).map(r => r.url),
    ...db.prepare(`SELECT avatar_url AS url FROM users WHERE avatar_url IS NOT NULL`).all().map(r => r.url),
  ];
  return new Set(urls.map(u => String(u || '').split('?')[0].split('/').pop()).filter(Boolean));
}

export function purgeOrphanUploads(now = Date.now()) {
  let entries;
  try {
    entries = fs.readdirSync(uploadsPath, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => {
        const full = path.join(uploadsPath, e.name);
        return { name: e.name, mtimeMs: fs.statSync(full).mtimeMs };
      });
  } catch {
    return 0;
  }
  const doomed = orphanUploads(entries, _referencedNames(), now, MIN_AGE_MS);
  let removed = 0;
  for (const name of doomed) {
    try { fs.unlinkSync(path.join(uploadsPath, name)); removed++; }
    catch (e) { logger.debug?.(`[uploads] could not remove ${name}: ${e.message}`); }
  }
  return removed;
}
