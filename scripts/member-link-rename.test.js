/**
 * An access audit after cooktrace#110: someone a note is shared with to
 * edit could rename it and have any [[link]] text rewritten across the
 * owner's notes, ones never shared with them included (naming the text
 * directly, or making it the title first). A member's rename now changes
 * links only in the owner's notes they may edit anyway.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

let notes = null, db = null, dir = null;
try {
  createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  dir = mkdtempSync(join(tmpdir(), 'note-member-links-'));
  process.env.DB_PATH = join(dir, 'test.db');
  db = (await import('../server/db.js')).default;
  notes = await import('../server/lib/notes.js');
} catch { /* better-sqlite3 not built for this Node: skipped */ }
test.after(() => { try { db?.close(); } catch {} if (dir) rmSync(dir, { recursive: true, force: true }); });

function seed() {
  const user = n => {
    const name = n + Math.random().toString(36).slice(2, 8);
    const id = Number(db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(name, 'x').lastInsertRowid);
    return { id, name };
  };
  const owner = user('owner'), member = user('member');
  const shared = notes.createNote(owner.id, { title: 'Groceries', body_md: 'milk' });
  const secret = notes.createNote(owner.id, { title: 'Diary', body_md: 'Met about [[Secret Plan]] today. Also [[Groceries]].' });
  const alsoShared = notes.createNote(owner.id, { title: 'Weekly', body_md: 'Buy from [[Groceries]].' });
  notes.addMember(owner.id, shared.id, { username: member.name, role: 'edit' });
  notes.addMember(owner.id, alsoShared.id, { username: member.name, role: 'edit' });
  const body = id => db.prepare('SELECT body_md FROM notes WHERE id = ?').get(id).body_md;
  return { owner, member, shared, secret, alsoShared, body };
}

test("an edit member can't rewrite links in the owner's notes they can't edit", (t) => {
  if (!notes) return t.skip('better-sqlite3 is not built for this Node');
  const s = seed();
  const before = s.body(s.secret.id);
  // Naming the text outright...
  notes.updateNote(s.member.id, s.shared.id, { title: 'Takeover', rename_links_from: 'Secret Plan' });
  notes.updateNote(s.member.id, s.shared.id, { links_from: 'Secret Plan' });
  // ...or making it the title first, then renaming.
  notes.updateNote(s.member.id, s.shared.id, { title: 'Secret Plan', rename_links: false });
  notes.updateNote(s.member.id, s.shared.id, { title: 'Takeover 2' });
  assert.equal(s.body(s.secret.id), before, 'a note never shared with them is untouched');
});

test("a member's rename in the app keeps links working in notes they share", (t) => {
  if (!notes) return t.skip('better-sqlite3 is not built for this Node');
  const s = seed();
  // As the editor does it: the title as it's typed, links when it closes.
  notes.updateNote(s.member.id, s.shared.id, { title: 'Shopping', rename_links: false });
  notes.updateNote(s.member.id, s.shared.id, { title: 'Shopping', rename_links_from: 'Groceries', links_only: true });
  assert.equal(s.body(s.alsoShared.id), 'Buy from [[Shopping]].');
});

test("the owner's own rename changes links in all their notes, as before", (t) => {
  if (!notes) return t.skip('better-sqlite3 is not built for this Node');
  const s = seed();
  notes.updateNote(s.owner.id, s.shared.id, { title: 'Shopping', rename_links: false });
  notes.updateNote(s.owner.id, s.shared.id, { title: 'Shopping', rename_links_from: 'Groceries', links_only: true });
  assert.equal(s.body(s.alsoShared.id), 'Buy from [[Shopping]].');
  assert.equal(s.body(s.secret.id), 'Met about [[Secret Plan]] today. Also [[Shopping]].');
});
