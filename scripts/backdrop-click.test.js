/**
 * Selecting text and letting go outside doesn't close a note or a popup
 * (found and first fixed by @harikiran-lab in their fork, TraceApps/notetrace#35).
 *
 * A browser sends a drag's click to the closest element holding both ends,
 * which for a selection that ends outside the panel is the backdrop. Only a
 * primary press and release that both land on the backdrop close it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { backdropClick } from '../src/lib/backdrop-click.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

function setup() {
  const node = new EventTarget();
  const panel = new EventTarget();
  let calls = 0;
  const action = backdropClick(node, () => calls++);
  const fire = (type, target = node, props = {}) => {
    const e = new Event(type);
    Object.defineProperty(e, 'target', { value: target });
    Object.assign(e, { button: 0, pointerId: 1, isPrimary: true }, props);
    node.dispatchEvent(e);
  };
  return { node, panel, action, fire, calls: () => calls };
}

test('a click on the backdrop closes it, once', () => {
  const s = setup();
  s.fire('pointerdown'); s.fire('pointerup'); s.fire('click');
  s.fire('click');
  assert.equal(s.calls(), 1);
});

test('selecting text inside and letting go outside keeps it open', () => {
  const s = setup();
  s.fire('pointerdown', s.panel); s.fire('pointerup'); s.fire('click');
  assert.equal(s.calls(), 0);
  // A click on the backdrop after that still closes it.
  s.fire('pointerdown'); s.fire('pointerup'); s.fire('click');
  assert.equal(s.calls(), 1);
});

test('a drag from the backdrop into the panel, or a click inside, keeps it open', () => {
  const s = setup();
  s.fire('pointerdown'); s.fire('pointerup', s.panel); s.fire('click');
  s.fire('pointerdown', s.panel); s.fire('pointerup', s.panel); s.fire('click', s.panel);
  assert.equal(s.calls(), 0);
});

test('a cancelled touch, another button, a second finger or a different pointer keep it open', () => {
  const s = setup();
  s.fire('pointerdown'); s.fire('pointercancel'); s.fire('pointerup'); s.fire('click');
  s.fire('pointerdown', s.node, { button: 2 }); s.fire('pointerup'); s.fire('click');
  s.fire('pointerdown', s.node, { isPrimary: false }); s.fire('pointerup'); s.fire('click');
  s.fire('pointerdown'); s.fire('pointerup', s.node, { pointerId: 2 }); s.fire('click');
  assert.equal(s.calls(), 0);
  // A touch is a primary pointer with button 0: a tap on the backdrop closes it.
  s.fire('pointerdown', s.node, { pointerType: 'touch' }); s.fire('pointerup', s.node, { pointerType: 'touch' }); s.fire('click');
  assert.equal(s.calls(), 1);
});

test('it follows the latest close action and lets go when removed', () => {
  const s = setup();
  let updated = 0;
  s.action.update(() => updated++);
  s.fire('pointerdown'); s.fire('pointerup'); s.fire('click');
  assert.equal([updated, s.calls()].join(), '1,0');
  s.action.destroy();
  s.fire('pointerdown'); s.fire('pointerup'); s.fire('click');
  assert.equal(updated, 1);
});

test('the note editor and every popup close only on a deliberate backdrop click', () => {
  const editor = read('../src/components/notes/NoteEditor.svelte');
  assert.match(editor, /class="editor-backdrop" class:inline use:backdropClick=\{\(\) => \{ if \(!inline\) close\(\); \}\}/);
  assert.doesNotMatch(editor, /class="editor-backdrop"[^\n]*on:click/);
  const pop = read('../src/components/notes/Popover.svelte');
  assert.match(pop, /class="pop-backdrop" class:narrow use:backdropClick=\{closeOutside\} use:closeOnBack=\{close\}/);
  assert.doesNotMatch(pop, /class="pop-backdrop"[^\n]*on:click/);
});
