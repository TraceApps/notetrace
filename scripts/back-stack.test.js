/**
 * Android's back button only closed the full-screen layers (a drawing, a
 * file, an image) before going back a page, so it left pages with a sheet,
 * dialog or open note still showing. Every open layer now registers with
 * back-stack.js and back closes the newest first. Same bug and fix as
 * NutriTrace #226.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { onBack, handleBack, backStackDepth, closeOnBack } from '../src/lib/back-stack.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('with nothing open, back is not taken (the page goes back as before)', () => {
  assert.equal(backStackDepth(), 0);
  assert.equal(handleBack(), false);
});

test('back closes the newest layer first', () => {
  const closed = [];
  const sheet = closeOnBack({}, () => closed.push('sheet'));
  const dialog = closeOnBack({}, () => closed.push('dialog'));
  assert.equal(handleBack(), true);
  assert.deepEqual(closed, ['dialog']);
  dialog.destroy();                       // the dialog's element goes away
  assert.equal(handleBack(), true);
  assert.deepEqual(closed, ['dialog', 'sheet']);
  sheet.destroy();
  assert.equal(backStackDepth(), 0);
  assert.equal(handleBack(), false, 'then back falls through to the page');
});

test('a layer closed some other way stops catching back', () => {
  let hits = 0;
  const layer = closeOnBack({}, () => hits++);
  layer.destroy();                        // closed with its X, or the page changed
  assert.equal(handleBack(), false);
  assert.equal(hits, 0);
});

test('a layer that must be answered keeps catching back', () => {
  // The sync merge questions pass a no-op: back must neither dismiss it nor
  // let the next press navigate away underneath it.
  const merge = closeOnBack({}, () => {});
  assert.equal(handleBack(), true);
  assert.equal(handleBack(), true, 'still there on the second press');
  merge.destroy();
  assert.equal(handleBack(), false);
});

test('the close action can change while the layer is open', () => {
  let which = '';
  const layer = closeOnBack({}, () => { which = 'first'; });
  layer.update(() => { which = 'second'; });
  handleBack();
  assert.equal(which, 'second');
  layer.destroy();
});

test('a handler that throws still counts as handled', () => {
  const release = onBack(() => { throw new Error('gone'); });
  assert.equal(handleBack(), true);
  release();
  assert.equal(backStackDepth(), 0);
});

test('the Android back button checks the stack, then the sidebar, then goes back a page', () => {
  const app = read('../src/App.svelte');
  const h = app.slice(app.indexOf("App.addListener('backButton'"), app.indexOf("App.addListener('appUrlOpen'"));
  const stackAt = h.indexOf('if (handleBack()) return;');
  const sideAt = h.indexOf('if (sidebarOpen && !sidebarPinned)');
  const pageAt = h.indexOf('window.history.back()');
  assert.ok(stackAt > 0 && sideAt > stackAt && pageAt > sideAt);
});

function walk(dir) {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
}

// A tag ends at the first '>' outside {...}, so arrow functions in
// attributes (on:click={() => ...}) don't cut it short.
function tagAt(s, start) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') depth--;
    else if (s[i] === '>' && depth === 0) return s.slice(start, i + 1);
  }
  return s.slice(start);
}

test('every modal overlay in the app is registered', () => {
  // Any element marked as a modal dialog must also be registered, so a new
  // sheet can't reintroduce #226 unnoticed. Sheet.svelte registers on its
  // backdrop, whose panel carries the role.
  // Inner panels of an already-registered backdrop carry the role too.
  const innerPanels = [
    ['components/ui/Sheet.svelte', 'sheet-panel'], ['components/ui/Dialog.svelte', 'dialog-box'],
    ['components/ui/ActionSheet.svelte', 'as-panel'], ['components/ui/TimePicker.svelte', 'tp-sheet'], ['components/notes/Popover.svelte', 'pop-panel'],
    ['components/notes/ShortcutsHelp.svelte', 'sh-panel'], ['components/settings/SettingsEmail.svelte', 'test-dialog'],
    // These register from their script (onBack) rather than in markup.
    ['components/notes/DrawingEditor.svelte', 'class="dw"'], ['components/notes/FileViewer.svelte', 'class="fv"'],
    ['components/notes/ImageViewer.svelte', 'class="viewer"'],
    // The app lock: back must never dismiss it.
    ['components/LockScreen.svelte', 'class="lock"'],
  ];
  const files = walk(new URL('../src/', import.meta.url).pathname).filter((f) => f.endsWith('.svelte'));
  const missing = [];
  let checked = 0;
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    const rel = f.split('/src/')[1];
    // Markup only: scripts mention [aria-modal="true"] in selectors.
    const markup = s.lastIndexOf('</script>');
    for (let at = s.indexOf('aria-modal="true"', markup); at >= 0; at = s.indexOf('aria-modal="true"', at + 1)) {
      const tag = tagAt(s, s.lastIndexOf('<', at));
      if (innerPanels.some(([file, cls]) => rel === file && tag.includes(cls))) continue;
      checked++;
      if (!/use:closeOnBack=/.test(tag)) missing.push(`${rel}: ${tag.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
  }
  assert.ok(checked >= 2, `found the overlays (${checked})`);
  assert.deepEqual(missing, []);
});

test('every hand-built backdrop and overlay is registered too', () => {
  // Overlays without aria-modal: a backdrop, overlay or scrim element.
  // These are the ones back rightly leaves alone:
  const notLayers = new Map([
    ['components/layout/Sidebar.svelte', 'sidebar-backdrop'],       // App.svelte closes the sidebar itself
    ['routes/Profile.svelte', 'avatar-overlay'],                     // a hover hint on the photo
    ['routes/Notes.svelte', 'fab-scrim'],                            // inside the + menu's layer, which is registered
    ['components/notes/NoteEditor.svelte', 'editor-backdrop'],       // registers from its script, and not as the side pane
  ]);
  const files = walk(new URL('../src/', import.meta.url).pathname).filter((f) => f.endsWith('.svelte'));
  const missing = [];
  let checked = 0;
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    const rel = f.split('/src/')[1];
    const markup = s.lastIndexOf('</script>');
    for (const m of s.slice(markup).matchAll(/<(div|aside|section)\b/g)) {
      const tag = tagAt(s, markup + m.index);
      const layer = ((tag.match(/class="([^"]*)"/) || [])[1] || '').split(/\s+/).find((c) => /(^|-)(backdrop|overlay|scrim)$/.test(c));
      if (!layer || notLayers.get(rel) === layer) continue;
      checked++;
      if (!/use:closeOnBack=/.test(tag)) missing.push(`${rel}: .${layer}`);
    }
  }
  assert.ok(checked >= 8, `found the overlays (${checked})`);
  assert.deepEqual(missing, []);
});

test('the shared components and hand-built sheets are registered', () => {
  assert.match(read('../src/components/ui/Sheet.svelte'), /class="sheet-backdrop" on:click=\{onBackdropClick\} use:closeOnBack=\{close\}/);
  assert.match(read('../src/components/ui/Dialog.svelte'), /class="dialog-backdrop"[^>]*use:closeOnBack=/);
  assert.match(read('../src/components/ui/ActionSheet.svelte'), /class="as-backdrop"[^>]*use:closeOnBack=/);
  assert.match(read('../src/components/notes/Popover.svelte'), /class="pop-backdrop"[^>]*use:closeOnBack=\{close\}/, 'the note menus (color, labels, reminder, share)');
  assert.match(read('../src/components/ui/ImagePicker.svelte'), /use:closeOnBack=\{stopCamera\}/, 'the camera stops, not just hides');
  assert.match(read('../src/components/ai/Trace.svelte'), /use:closeOnBack=\{\(\) => panelOpen = false\}/);
  assert.match(read('../src/routes/Notes.svelte'), /class="fab-layer" use:portal use:closeOnBack=\{\(\) => fabMenu = false\}/);
});

test('an open note closes on back, saving the way its close button does', () => {
  const ed = read('../src/components/notes/NoteEditor.svelte');
  assert.match(ed, /const releaseBack = inline \? \(\) => \{\} : onBack\(\(\) => close\(\)\);/, 'not the side pane');
  assert.match(ed, /onDestroy\(\(\) => \{[\s\S]*?releaseBack\(\);[\s\S]*?\}\);/);
  // Registered as the editor starts, not in onMount: Svelte mounts children
  // first, and a layer opened inside the note has to sit above it.
  const mount = ed.slice(ed.indexOf('onMount(async () => {'), ed.indexOf('onDestroy(() => {'));
  assert.doesNotMatch(mount, /onBack\(/);
});

test('the drawing editor steps back like Escape: palette, then selection, then done', () => {
  const dw = read('../src/components/notes/DrawingEditor.svelte');
  assert.match(dw, /releaseBack = onBack\(stepBack\)/);
  assert.match(dw, /if \(e\.key === 'Escape'\) \{\s*e\.preventDefault\(\); e\.stopPropagation\(\);\s*stepBack\(\);/);
  assert.match(read('../src/components/notes/FileViewer.svelte'), /releaseBack = onBack\(close\)/);
  assert.match(read('../src/components/notes/ImageViewer.svelte'), /releaseBack = onBack\(close\)/);
});

test('the drawing editor keeps catching back while it saves', () => {
  // done() returns early while busy. Back used to drop the entry anyway, so
  // a second press left the page mid-save; now it waits for the editor to close.
  let busy = true, finished = 0;
  const release = onBack(() => { if (busy) return; finished++; });
  assert.equal(handleBack(), true);
  assert.equal(handleBack(), true, 'still the editor, not the page');
  busy = false;
  handleBack();
  assert.equal(finished, 1);
  release();
  assert.equal(backStackDepth(), 0);
});

test('the sync merge questions swallow back rather than dismissing them', () => {
  const sc = read('../src/components/settings/SettingsServerConnection.svelte');
  assert.equal((sc.match(/class="merge-overlay"[^>]*use:closeOnBack=\{\(\) => \{\}\}/g) || []).length, 3);
});
