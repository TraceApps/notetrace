import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanTemplate, cleanTemplates, templateFromNote, canTemplate, fillTokens, noteFromTemplate,
  MAX_TEMPLATES, MAX_NAME,
} from '../src/lib/note-templates.js';

test('a checklist becomes a template in item order, without checks', () => {
  const t = templateFromNote({
    kind: 'checklist', title: 'Packing', color: 'sky', body_md: 'stray',
    items: [{ text: 'Socks', position: 2, checked: true }, { text: 'Passport', position: 1 }, { text: '  ', position: 3 }],
  }, 'Trip');
  assert.equal(t.name, 'Trip');
  assert.equal(t.kind, 'checklist');
  assert.deepEqual(t.items, ['Passport', 'Socks']);
  assert.equal(t.body_md, '');
  assert.equal(t.color, 'sky');
  assert.ok(t.id);
});

test('a template without a name takes the title, and one with neither is dropped', () => {
  assert.equal(cleanTemplate({ title: 'Standup', body_md: 'x' }).name, 'Standup');
  assert.equal(cleanTemplate({ body_md: 'x' }), null);
  assert.equal(cleanTemplate('nope'), null);
  assert.equal(cleanTemplate({ name: 'x'.repeat(200) }).name.length, MAX_NAME);
});

test('odd colours and kinds are cleaned', () => {
  const t = cleanTemplate({ name: 'A', kind: 'weird', color: 'url(x)', items: ['a'] });
  assert.equal(t.kind, 'text');
  assert.equal(t.color, null);
  assert.deepEqual(t.items, []);
});

test('the saved list drops repeats and stops at the limit', () => {
  const many = Array.from({ length: MAX_TEMPLATES + 5 }, (_, i) => ({ id: `t${i}`, name: `T${i}` }));
  assert.equal(cleanTemplates(many).length, MAX_TEMPLATES);
  assert.equal(cleanTemplates([{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }]).length, 1);
  assert.deepEqual(cleanTemplates(null), []);
});

test('only a note with something in it can be a template', () => {
  assert.equal(canTemplate({ kind: 'text', title: '', body_md: '  ' }), false);
  assert.equal(canTemplate({ kind: 'text', title: 'Hi' }), true);
  assert.equal(canTemplate({ kind: 'checklist', items: [{ text: '' }] }), false);
  assert.equal(canTemplate({ kind: 'checklist', items: [{ text: 'Milk' }] }), true);
});

test('tokens fill in, in any case, and plain text is left alone', () => {
  const now = new Date(2026, 8, 16, 9, 5);
  const out = fillTokens('Standup {date} ({Weekday})', now, { formatDate: () => 'Sep 16, 2026', locale: 'en-US' });
  assert.equal(out, 'Standup Sep 16, 2026 (Wednesday)');
  assert.match(fillTokens('{time}', now, { locale: 'en-US' }), /9:05/);
  assert.equal(fillTokens('no tokens', now), 'no tokens');
  assert.equal(fillTokens('', now), '');
});

test('a new note from a template gets fresh unchecked items and filled tokens', () => {
  const tpl = { id: 'x', name: 'Daily', kind: 'checklist', title: 'Day {date}', items: ['Water {date}', 'Walk'], color: 'moss' };
  const a = noteFromTemplate(tpl, { formatDate: () => 'D' });
  const b = noteFromTemplate(tpl, { formatDate: () => 'D' });
  assert.equal(a.title, 'Day D');
  assert.deepEqual(a.items.map(i => [i.text, i.checked, i.position]), [['Water D', false, 1], ['Walk', false, 2]]);
  assert.notEqual(a.items[0].uuid, b.items[0].uuid);
  assert.equal(a.color, 'moss');
  const text = noteFromTemplate({ name: 'Meeting', kind: 'text', title: '', body_md: '## {date}\n\n- ' }, { formatDate: () => 'D' });
  assert.equal(text.body_md, '## D\n\n- ');
  assert.deepEqual(text.items, []);
});
