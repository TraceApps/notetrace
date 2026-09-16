import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAudio, isImage, isFile, extOf, fileTypeLabel, fileIcon, previewKind, formatBytes, displayName } from '../src/lib/file-kinds.js';

test('attachments sort into pictures, voice notes, and files', () => {
  assert.equal(isImage({ url: '/uploads/a.jpg' }), true, 'old attachments with no type are pictures');
  assert.equal(isImage({ mime: 'image/png' }), true);
  assert.equal(isAudio({ mime: 'audio/webm' }), true);
  assert.equal(isFile({ mime: 'application/pdf', url: '/uploads/a.pdf' }), true);
  assert.equal(isFile({ mime: 'video/mp4', url: '/uploads/a.mp4' }), true, 'a video is a file with a player');
  assert.equal(isFile({ mime: 'image/jpeg' }), false);
  assert.equal(isFile(null), false);
});

test('a file is known by its type, or else its name', () => {
  assert.equal(extOf({ name: 'Quote.PDF', url: '/uploads/x.bin' }), 'pdf');
  assert.equal(extOf({ url: '/uploads/1-a.docx?v=2' }), 'docx');
  assert.equal(fileTypeLabel({ mime: 'application/pdf' }), 'PDF');
  assert.equal(fileTypeLabel({ mime: 'application/octet-stream', name: 'budget.xlsx' }), 'Spreadsheet');
  assert.equal(fileTypeLabel({ mime: 'application/octet-stream', name: 'thing.dat' }), 'DAT');
  assert.equal(fileTypeLabel({ mime: 'application/octet-stream', url: '/uploads/x.bin' }), 'File');
  assert.equal(fileIcon({ name: 'photos.zip' }), 'folder_zip');
  assert.equal(fileIcon({ name: 'weird.thing' }), 'draft');
});

test('the viewer shows PDFs, text, and video, and offers the rest as a download', () => {
  assert.equal(previewKind({ mime: 'application/pdf' }), 'pdf');
  assert.equal(previewKind({ name: 'notes.md' }), 'text');
  assert.equal(previewKind({ name: 'data.csv' }), 'text');
  assert.equal(previewKind({ mime: 'video/quicktime', name: 'clip.mov' }), 'video');
  assert.equal(previewKind({ name: 'plan.docx' }), 'none');
});

test('sizes read like a person would say them', () => {
  assert.equal(formatBytes(1), '1 byte');
  assert.equal(formatBytes(900), '900 bytes');
  assert.equal(formatBytes(2048), '2.0 KB'.replace('2.0', '2'));
  assert.equal(formatBytes(2.4 * 1048576), '2.4 MB');
  assert.equal(formatBytes(150 * 1048576), '150 MB');
  assert.equal(formatBytes(null), '');
});

test('a file without a name shows its stored name', () => {
  assert.equal(displayName({ name: '  Lease.pdf ' }), 'Lease.pdf');
  assert.equal(displayName({ url: '/uploads/123-abc.pdf' }), '123-abc.pdf');
});
