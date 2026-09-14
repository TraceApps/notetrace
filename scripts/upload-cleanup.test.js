import assert from 'node:assert/strict';
import test from 'node:test';
import { orphanUploads } from '../server/lib/upload-cleanup-core.js';

test('upload cleanup deletes only old, unreferenced, visible files', () => {
  const now = 10 * 86400000;
  const day = 86400000;
  const entries = [
    { name: 'kept-referenced.png', mtimeMs: now - 5 * day },
    { name: 'orphan-old.png', mtimeMs: now - 2 * day },
    { name: 'orphan-new.png', mtimeMs: now - 60 * 1000 },
    { name: '.gitkeep', mtimeMs: 0 },
  ];
  assert.deepEqual(orphanUploads(entries, new Set(['kept-referenced.png']), now, day), ['orphan-old.png']);
});
