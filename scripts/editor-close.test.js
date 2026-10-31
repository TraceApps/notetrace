/**
 * Picking another note in the List layout's pane swapped the note without
 * closing the one open: a rename never reached its [[links]], a note
 * emptied there stayed as a blank card, the lists and sidebar weren't told,
 * and typing just before leaving the page was dropped. Every way a note
 * goes now runs the editor's close steps once (lib/editor-close.js).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { editorCloser } from '../src/lib/editor-close.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const notes = read('../src/routes/Notes.svelte');
const editor = read('../src/components/notes/NoteEditor.svelte');
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Steps that record what ran; renameLinks waits until released. */
function recorder({ rename = true, id = 7 } = {}) {
  const ran = [];
  let release;
  const renaming = new Promise((r) => { release = r; });
  const steps = {
    flush: async () => { ran.push('flush'); },
    renameLinks: async () => { ran.push('links'); await renaming; return rename; },
    dropIfEmpty: async (skip, untouchedStays) => { ran.push(`drop:${skip}${untouchedStays ? ':untouched-stays' : ''}`); },
    announce: (skip) => { ran.push(`announce:${skip}`); },
    noteId: () => id,
  };
  return { ran, steps, release };
}

test('finish runs every close step once, in order, and says what it did', async () => {
  const r = recorder();
  const c = editorCloser(r.steps);
  const p = c.finish();
  r.release();
  assert.deepEqual(await p, { id: 7, renamed: true });
  assert.deepEqual(r.ran, ['flush', 'links', 'flush', 'drop:false', 'announce:false']);
});

test('typing that comes in while the links go out is saved too (a second flush after them)', async () => {
  const r = recorder();
  const c = editorCloser(r.steps);
  const p = c.finish();
  await tick();
  assert.deepEqual(r.ran, ['flush', 'links']);
  r.release();
  await p;
  assert.equal(r.ran.filter((s) => s === 'flush').length, 2);
  assert.ok(r.ran.lastIndexOf('flush') > r.ran.indexOf('links'));
});

test('Done pressed while a switch is closing the note gets the same run, not a second one', async () => {
  const r = recorder();
  const c = editorCloser(r.steps);
  const left = c.leave();
  const done = c.finish(true);
  assert.equal(left, done);
  assert.equal(c.leaving, true);
  r.release();
  await done;
  assert.deepEqual(r.ran, ['flush', 'links', 'flush', 'drop:false:untouched-stays', 'announce:false']);
});

test('only Done removes an empty note merely opened; leaving it any other way keeps it', async () => {
  const done = recorder(); done.release();
  await editorCloser(done.steps).finish();
  assert.ok(done.ran.includes('drop:false'));
  for (const how of ['leave', 'pass']) {
    const r = recorder(); r.release();
    await editorCloser(r.steps)[how]();
    assert.ok(r.ran.includes('drop:false:untouched-stays'), how);
  }
});

test('a close on its own is not a switch', async () => {
  const r = recorder({ rename: false, id: null });
  const c = editorCloser(r.steps);
  r.release();
  assert.deepEqual(await c.finish(true), { id: null, renamed: false });
  assert.equal(c.leaving, false);
  assert.deepEqual(r.ran.slice(-2), ['drop:true', 'announce:true']);
});

test('an editor that goes without closing (the page left) closes on its way out', async () => {
  const r = recorder();
  const c = editorCloser(r.steps);
  const p = c.gone(true);
  // The pending save starts before the editor finishes going (its timers are cleared next).
  assert.deepEqual(r.ran, ['flush']);
  r.release();
  await p;
  assert.deepEqual(r.ran, ['flush', 'links', 'flush', 'drop:false:untouched-stays', 'announce:false']);
});

test('closed already: going away only saves what was typed during the close', async () => {
  const r = recorder();
  const c = editorCloser(r.steps);
  r.release();
  await c.finish();
  r.ran.length = 0;
  await c.gone(true);
  assert.deepEqual(r.ran, ['flush']);
});

test('handed off to another editor, or another account signed in: nothing runs on the way out', async () => {
  for (const [handOff, same] of [[true, true], [false, false], [true, false]]) {
    const r = recorder();
    const c = editorCloser(r.steps);
    if (handOff) c.handOff();
    assert.equal(c.gone(same), null);
    await tick();
    assert.deepEqual(r.ran, []);
  }
});

test('a close step that throws on the way out is not an unhandled rejection', async () => {
  const c = editorCloser({
    flush: async () => { throw new Error('offline'); },
    renameLinks: async () => false, dropIfEmpty: async () => {}, announce: () => {},
  });
  assert.equal(await c.gone(true), null);
});

test('the editor closes through the closer, and a close that ends during a switch sends no close event', () => {
  assert.match(editor, /import \{ editorCloser \} from '\.\.\/\.\.\/lib\/editor-close\.js';/);
  assert.match(editor, /async function close\(skipDiscard = false, navigate = null\) \{\s+if \(closing\) return;\s+closing = true;\s+try \{ await closer\.finish\(skipDiscard\); \} catch \{[^}]*\}[\s\S]{0,120}if \(closer\.leaving\) return;\s+dispatch\('close', \{ id: noteId, navigate \}\);/);
  // The steps closing always had: links only, the empty note removed, the lists told.
  assert.match(editor, /renameLinks\(\) \{[\s\S]*?NoteApi\.updateNote\(noteId, \{ title, rename_links_from: renamedFrom, links_only: true \}\)[\s\S]*?return true;/);
  assert.match(editor, /dropIfEmpty\(skipDiscard, untouchedStays\) \{[\s\S]*?if \(!skipDiscard && !\(untouchedStays && !touched\) && noteId[\s\S]*?isEmptyNote\(\{ title, body_md: body, items, attachments \}\)[\s\S]*?NoteApi\.deleteNoteForever\(noteId\)/);
  assert.match(editor, /announce\(skipDiscard\) \{\s+if \(touched \|\| skipDiscard\) signalNotesChanged\(\);\s+refreshLabels\(\);/);
  assert.match(editor, /export function leave\(\) \{ return closer\.leave\(\); \}/);
  assert.match(editor, /export function handOff\(\) \{ closer\.handOff\(\); return openedTitle; \}/);
  assert.match(editor, /export function finish\(\) \{ return closer\.pass\(\); \}/);
});

test('going away runs the closer before the pending save timer is cleared, and not after a sign-out', () => {
  assert.match(editor, /const openedBy = get\(currentUser\)\?\.id \?\? null;/);
  assert.match(editor, /closer\.gone\(\(get\(currentUser\)\?\.id \?\? null\) === openedBy\);\s+clearTimeout\(textTimer\);/);
  // Leaving a shared note closes nothing more.
  assert.match(editor, /function onLeft\(\) \{\s+shareOpen = false;\s+closer\.handOff\(\);/);
});

test('picking another note in the pane closes the one there first, then opens the next as it is now', () => {
  const open = notes.match(/async function openInPane\(entry\) \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.match(open, /const leftId = paneRef\?\.currentNoteId\?\.\(\) \?\? null;\s+let left = null;\s+try \{ left = await paneRef\?\.leave\?\.\(\); \}/);
  assert.doesNotMatch(open, /flush/);
  // Only the last pick opens.
  assert.match(open, /const seq = \+\+paneSeq;/);
  assert.equal((open.match(/if \(seq !== paneSeq\) return;/g) || []).length, 2);
  // An emptied note picked again isn't reopened after it was removed.
  assert.match(open, /if \(left\.id == null && leftId != null && entry\.note\.id === leftId\) \{\s+pane = null;/);
  assert.match(open, /if \(left\.renamed \|\| entry\.note\.id === leftId\) \{\s+try \{ entry = \{ \.\.\.entry, note: \(await NoteApi\.getNote\(entry\.note\.id\)\) \|\| entry\.note \}; \}/);
  // A link followed from the pane gives way to a note picked meanwhile.
  assert.match(notes, /async function closePane\(e\) \{[\s\S]*?const seq = \+\+paneSeq;[\s\S]*?if \(n && seq === paneSeq\) openInPane/);
  // A reminder link beside the list opens the same way.
  assert.match(notes, /if \(n && splitPane\) openInPane\(\{ note: n \}\);\s+else if \(n\) editing = \{ note: n \};/);
});

test('the pane closing for another layout closes its note; folding hands it on with the title it opened with', () => {
  const toOverlay = notes.match(/async function movePaneToOverlay\(reopen\) \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.match(toOverlay, /if \(!reopen\) \{ try \{ await paneRef\?\.leave\?\.\(\); \}/);
  assert.match(toOverlay, /paneSeq\+\+;/);
  const toPane = notes.match(/async function moveOverlayToPane\(\) \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.match(toPane, /paneSeq\+\+;/);
  // The pane's note closes before the one coming over is read.
  assert.ok(toPane.indexOf('await paneRef?.leave?.()') >= 0 && toPane.indexOf('await paneRef?.leave?.()') < toPane.indexOf('_openedNote(overlayRef'));
  const opened = notes.match(/async function _openedNote\(ref, entry\) \{[\s\S]*?\n  \}/)?.[0] || '';
  // Taken before the first wait: the editor may be on its way out already.
  assert.ok(opened.indexOf('ref?.handOff?.()') >= 0 && opened.indexOf('ref?.handOff?.()') < opened.indexOf('await'));
  assert.match(opened, /if \(!note\) \{ try \{ await ref\?\.finish\?\.\(\); \}/);
  assert.match(opened, /return \{ note, openedAs \};/);
  assert.match(editor, /const openedTitle = openedAs \?\? note\?\.title \?\? '';/);
  assert.equal((notes.match(/openedAs=\{(pane|editing)\.openedAs \?\? null\}/g) || []).length, 2);
});
