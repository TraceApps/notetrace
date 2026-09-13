/**
 * notes-native.js: note, checklist, label, and version operations on the
 * on-device SQLite database. Mirrors server/lib/notes.js so a note behaves
 * the same offline as it does on the server. Every write marks the row
 * sync_status 'pending' so the sync engine pushes it.
 *
 * Merged into NoteApiNative (api-native.js).
 */
import { getDb, LOCAL_USER_ID } from './db-native.js';

export const NOTE_COLORS = ['plum', 'moss', 'clay', 'tide', 'sand', 'rose'];
const VERSION_SESSION_MS = 10 * 60 * 1000;
const VERSION_KEEP_PER_NOTE = 50;

function _now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function _ms(s) {
  if (!s) return NaN;
  const iso = String(s).includes('T') ? String(s) : String(s).replace(' ', 'T');
  return Date.parse(/[zZ]$/.test(iso) ? iso : iso + 'Z');
}
function _uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

async function _q(sql, params = []) {
  const db = await getDb();
  return (await db.query(sql, params))?.values || [];
}
async function _run(sql, params = []) {
  const db = await getDb();
  return db.run(sql, params);
}
async function _insert(sql, params = []) {
  const r = await _run(sql, params);
  return r?.changes?.lastId ?? r?.lastId ?? null;
}

// ── Reads ────────────────────────────────────────────────────────────

async function _hydrate(rows) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const ph = ids.map(() => '?').join(',');
  const items = await _q(
    `SELECT note_id, uuid, text, checked, position FROM checklist_items
      WHERE note_id IN (${ph}) AND deleted_at IS NULL ORDER BY position ASC, id ASC`, ids);
  const links = await _q(
    `SELECT nl.note_id, nl.label_id FROM note_labels nl
       JOIN labels l ON l.id = nl.label_id AND l.deleted_at IS NULL
      WHERE nl.note_id IN (${ph}) AND nl.deleted_at IS NULL`, ids);
  const itemMap = new Map();
  for (const it of items) {
    if (!itemMap.has(it.note_id)) itemMap.set(it.note_id, []);
    itemMap.get(it.note_id).push({ uuid: it.uuid, text: it.text, checked: !!it.checked, position: it.position });
  }
  const labelMap = new Map();
  for (const l of links) {
    if (!labelMap.has(l.note_id)) labelMap.set(l.note_id, []);
    labelMap.get(l.note_id).push(l.label_id);
  }
  return rows.map(r => ({
    id: r.id,
    title: r.title,
    body_md: r.body_md,
    kind: r.kind,
    color: r.color,
    pinned: !!r.pinned,
    archived: !!r.archived,
    trashed_at: r.trashed_at,
    reminder_at: r.reminder_at,
    reminder_rrule: r.reminder_rrule,
    created_at: r.created_at,
    updated_at: r.updated_at,
    labels: labelMap.get(r.id) || [],
    items: itemMap.get(r.id) || [],
  }));
}

async function _row(id) {
  return (await _q(
    `SELECT * FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL`, [id, LOCAL_USER_ID]))[0] || null;
}

async function _note(id) {
  const row = await _row(id);
  return row ? (await _hydrate([row]))[0] : null;
}

// Local search matches every word somewhere in the title, body, or a
// checklist item. LIKE instead of FTS5 because the on-device SQLite build
// isn't guaranteed to ship FTS5; at personal scale it's fast enough.
function _searchClause(q) {
  const words = String(q || '').match(/[\p{L}\p{N}]+/gu) || [];
  if (!words.length) return { sql: '', args: [] };
  const parts = [];
  const args = [];
  for (const w of words.slice(0, 12)) {
    const like = `%${w.replace(/[%_]/g, '')}%`;
    parts.push(`(n.title LIKE ? OR n.body_md LIKE ? OR EXISTS (
      SELECT 1 FROM checklist_items ci WHERE ci.note_id = n.id AND ci.deleted_at IS NULL AND ci.text LIKE ?))`);
    args.push(like, like, like);
  }
  return { sql: ' AND ' + parts.join(' AND '), args };
}

// ── Versions ─────────────────────────────────────────────────────────

async function _itemsJson(noteId) {
  const rows = await _q(
    `SELECT uuid, text, checked, position FROM checklist_items
      WHERE note_id = ? AND deleted_at IS NULL ORDER BY position ASC, id ASC`, [noteId]);
  return rows.length ? JSON.stringify(rows.map(r => ({ ...r, checked: !!r.checked }))) : null;
}

async function _snapshot(row, reason = 'edit') {
  if (!row) return;
  if (reason === 'edit') {
    const last = (await _q(`SELECT created_at FROM note_versions WHERE note_id = ? ORDER BY id DESC LIMIT 1`, [row.id]))[0];
    if (last && Date.now() - _ms(last.created_at) < VERSION_SESSION_MS) return;
  }
  const items = await _itemsJson(row.id);
  if (!row.title && !row.body_md && !items) return;
  await _insert(
    `INSERT INTO note_versions (note_id, title, body_md, kind, items_json, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.title || '', row.body_md || '', row.kind || 'text', items, reason, _now()]);
  await _run(
    `DELETE FROM note_versions WHERE note_id = ? AND id NOT IN (
       SELECT id FROM note_versions WHERE note_id = ? ORDER BY id DESC LIMIT ?)`,
    [row.id, row.id, VERSION_KEEP_PER_NOTE]);
}

// ── Helpers ──────────────────────────────────────────────────────────

async function _touch(noteId, ts) {
  await _run(`UPDATE notes SET updated_at = ?, sync_status = 'pending' WHERE id = ?`, [ts, noteId]);
}

async function _upsertItem(noteId, it, ts) {
  const uuid = typeof it.uuid === 'string' && it.uuid ? it.uuid : _uuid();
  const existing = (await _q(`SELECT id FROM checklist_items WHERE uuid = ?`, [uuid]))[0];
  const text = String(it.text ?? '').slice(0, 5000);
  const position = Number.isFinite(+it.position) ? +it.position : 0;
  if (existing) {
    await _run(
      `UPDATE checklist_items SET text = ?, checked = ?, position = ?, updated_at = ?, deleted_at = NULL, sync_status = 'pending' WHERE id = ?`,
      [text, it.checked ? 1 : 0, position, ts, existing.id]);
  } else {
    await _insert(
      `INSERT INTO checklist_items (uuid, user_id, note_id, text, checked, position, created_at, updated_at, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [uuid, LOCAL_USER_ID, noteId, text, it.checked ? 1 : 0, position, ts, ts]);
  }
  return uuid;
}

async function _tombstoneItems(noteId, ts) {
  await _run(
    `UPDATE checklist_items SET deleted_at = ?, updated_at = ?, sync_status = 'pending' WHERE note_id = ? AND deleted_at IS NULL`,
    [ts, ts, noteId]);
}

async function _setLabels(noteId, labelIds, ts) {
  const wanted = new Set(labelIds.map(Number).filter(Number.isFinite));
  const owned = new Set((await _q(`SELECT id FROM labels WHERE deleted_at IS NULL`)).map(r => r.id));
  const existing = await _q(`SELECT id, label_id, deleted_at FROM note_labels WHERE note_id = ?`, [noteId]);
  for (const lid of wanted) {
    if (!owned.has(lid)) continue;
    const row = existing.find(r => r.label_id === lid);
    if (!row) {
      await _insert(
        `INSERT INTO note_labels (user_id, note_id, label_id, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, 'pending')`,
        [LOCAL_USER_ID, noteId, lid, ts, ts]);
    } else if (row.deleted_at) {
      await _run(`UPDATE note_labels SET deleted_at = NULL, updated_at = ?, sync_status = 'pending' WHERE id = ?`, [ts, row.id]);
    }
  }
  for (const row of existing) {
    if (row.deleted_at || wanted.has(row.label_id)) continue;
    await _run(`UPDATE note_labels SET deleted_at = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`, [ts, ts, row.id]);
  }
}

// ── API ──────────────────────────────────────────────────────────────

export const NotesNative = {
  async getNotes({ view = 'notes', label = null, q = '' } = {}) {
    const where = ['n.user_id = ?', 'n.deleted_at IS NULL'];
    const args = [LOCAL_USER_ID];
    if (view === 'trash') where.push('n.trashed_at IS NOT NULL');
    else {
      where.push('n.trashed_at IS NULL');
      where.push(view === 'archive' ? 'n.archived = 1' : 'n.archived = 0');
    }
    if (label != null) {
      where.push(`EXISTS (SELECT 1 FROM note_labels nl WHERE nl.note_id = n.id AND nl.label_id = ? AND nl.deleted_at IS NULL)`);
      args.push(Number(label));
    }
    const search = _searchClause(q);
    const order = view === 'notes' ? 'n.pinned DESC, n.updated_at DESC' : 'n.updated_at DESC';
    const rows = await _q(
      `SELECT n.* FROM notes n WHERE ${where.join(' AND ')}${search.sql} ORDER BY ${order}`,
      [...args, ...search.args]);
    return _hydrate(rows);
  },

  async getNote(id) {
    return _note(Number(id));
  },

  async createNote(data = {}) {
    const ts = _now();
    const kind = data.kind === 'checklist' ? 'checklist' : 'text';
    const id = await _insert(
      `INSERT INTO notes (user_id, title, body_md, kind, color, pinned, archived, created_at, updated_at, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [LOCAL_USER_ID, String(data.title ?? ''), kind === 'text' ? String(data.body_md ?? '') : '', kind,
       NOTE_COLORS.includes(data.color) ? data.color : null, data.pinned ? 1 : 0, data.archived ? 1 : 0, ts, ts]);
    if (kind === 'checklist' && Array.isArray(data.items)) {
      for (let i = 0; i < data.items.length; i++) {
        await _upsertItem(id, { ...data.items[i], position: data.items[i].position ?? i + 1 }, ts);
      }
    }
    if (Array.isArray(data.labels)) await _setLabels(id, data.labels, ts);
    return _note(id);
  },

  async updateNote(id, patch = {}) {
    id = Number(id);
    const row = await _row(id);
    if (!row) throw new Error('Note not found');
    const changing = ('title' in patch && String(patch.title) !== row.title)
      || ('body_md' in patch && String(patch.body_md) !== row.body_md);
    if (changing) await _snapshot(row, 'edit');
    const sets = [];
    const args = [];
    if ('title' in patch)   { sets.push('title = ?');   args.push(String(patch.title ?? '')); }
    if ('body_md' in patch) { sets.push('body_md = ?'); args.push(String(patch.body_md ?? '')); }
    if ('color' in patch)   { sets.push('color = ?');   args.push(NOTE_COLORS.includes(patch.color) ? patch.color : null); }
    if ('pinned' in patch)  { sets.push('pinned = ?');  args.push(patch.pinned ? 1 : 0); }
    if ('archived' in patch) {
      sets.push('archived = ?'); args.push(patch.archived ? 1 : 0);
      if (patch.archived) sets.push('pinned = 0');
    }
    const ts = _now();
    if (sets.length) {
      await _run(`UPDATE notes SET ${sets.join(', ')}, updated_at = ?, sync_status = 'pending' WHERE id = ?`, [...args, ts, id]);
    }
    if (Array.isArray(patch.labels)) await _setLabels(id, patch.labels, ts);
    return _note(id);
  },

  async convertNote(id, kind) {
    id = Number(id);
    const row = await _row(id);
    if (!row) throw new Error('Note not found');
    if (row.kind === kind || !['text', 'checklist'].includes(kind)) return _note(id);
    await _snapshot(row, 'restore');
    const ts = _now();
    if (kind === 'checklist') {
      const lines = String(row.body_md || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
        const m = l.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/);
        if (m) return { text: m[2], checked: m[1].toLowerCase() === 'x' };
        return { text: l.replace(/^([-*+]|\d+[.)])\s+/, ''), checked: false };
      });
      for (let i = 0; i < lines.length; i++) await _upsertItem(id, { ...lines[i], position: i + 1 }, ts);
      await _run(`UPDATE notes SET kind = 'checklist', body_md = '', updated_at = ?, sync_status = 'pending' WHERE id = ?`, [ts, id]);
    } else {
      const items = await _q(`SELECT text, checked FROM checklist_items WHERE note_id = ? AND deleted_at IS NULL ORDER BY position, id`, [id]);
      const body = items.map(it => `- [${it.checked ? 'x' : ' '}] ${it.text}`).join('\n');
      await _tombstoneItems(id, ts);
      await _run(`UPDATE notes SET kind = 'text', body_md = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`, [body, ts, id]);
    }
    return _note(id);
  },

  async trashNote(id) {
    const ts = _now();
    await _run(`UPDATE notes SET trashed_at = ?, pinned = 0, updated_at = ?, sync_status = 'pending' WHERE id = ?`, [ts, ts, Number(id)]);
    return _note(Number(id));
  },

  async restoreNote(id) {
    await _run(`UPDATE notes SET trashed_at = NULL, updated_at = ?, sync_status = 'pending' WHERE id = ?`, [_now(), Number(id)]);
    return _note(Number(id));
  },

  async deleteNoteForever(id) {
    id = Number(id);
    const ts = _now();
    await _tombstoneItems(id, ts);
    await _run(`UPDATE note_labels SET deleted_at = ?, updated_at = ?, sync_status = 'pending' WHERE note_id = ? AND deleted_at IS NULL`, [ts, ts, id]);
    await _run(`UPDATE notes SET deleted_at = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`, [ts, ts, id]);
    await _run(`DELETE FROM note_versions WHERE note_id = ?`, [id]);
    return { ok: true };
  },

  async emptyTrash() {
    const rows = await _q(`SELECT id FROM notes WHERE trashed_at IS NOT NULL AND deleted_at IS NULL`);
    for (const r of rows) await NotesNative.deleteNoteForever(r.id);
    return { deleted: rows.length };
  },

  // Checklist items

  async addItem(noteId, data = {}) {
    noteId = Number(noteId);
    const ts = _now();
    let position = Number(data.position);
    if (!Number.isFinite(position)) {
      const max = (await _q(`SELECT MAX(position) AS p FROM checklist_items WHERE note_id = ? AND deleted_at IS NULL`, [noteId]))[0];
      position = (max?.p || 0) + 1;
    }
    await _upsertItem(noteId, { uuid: data.uuid, text: data.text, checked: data.checked, position }, ts);
    await _touch(noteId, ts);
    return _note(noteId);
  },

  async updateItem(noteId, uuid, patch = {}) {
    noteId = Number(noteId);
    const item = (await _q(`SELECT * FROM checklist_items WHERE uuid = ? AND note_id = ? AND deleted_at IS NULL`, [uuid, noteId]))[0];
    if (!item) throw new Error('Item not found');
    const ts = _now();
    await _upsertItem(noteId, {
      uuid,
      text: 'text' in patch ? patch.text : item.text,
      checked: 'checked' in patch ? patch.checked : item.checked,
      position: 'position' in patch ? patch.position : item.position,
    }, ts);
    await _touch(noteId, ts);
    return _note(noteId);
  },

  async deleteItem(noteId, uuid) {
    noteId = Number(noteId);
    const ts = _now();
    await _run(`UPDATE checklist_items SET deleted_at = ?, updated_at = ?, sync_status = 'pending' WHERE uuid = ? AND note_id = ?`, [ts, ts, uuid, noteId]);
    await _touch(noteId, ts);
    return _note(noteId);
  },

  async reorderItems(noteId, uuids = []) {
    noteId = Number(noteId);
    const ts = _now();
    for (let i = 0; i < uuids.length; i++) {
      await _run(`UPDATE checklist_items SET position = ?, updated_at = ?, sync_status = 'pending' WHERE uuid = ? AND note_id = ? AND deleted_at IS NULL`, [i + 1, ts, uuids[i], noteId]);
    }
    await _touch(noteId, ts);
    return _note(noteId);
  },

  // Versions

  async getVersions(noteId) {
    const rows = await _q(
      `SELECT id, title, body_md, kind, items_json, reason, created_at FROM note_versions WHERE note_id = ? ORDER BY id DESC`, [Number(noteId)]);
    return rows.map(v => ({ ...v, items: v.items_json ? JSON.parse(v.items_json) : [], items_json: undefined }));
  },

  async restoreVersion(noteId, versionId) {
    noteId = Number(noteId);
    const row = await _row(noteId);
    const v = (await _q(`SELECT * FROM note_versions WHERE id = ? AND note_id = ?`, [Number(versionId), noteId]))[0];
    if (!row || !v) throw new Error('Version not found');
    await _snapshot(row, 'restore');
    const ts = _now();
    await _run(`UPDATE notes SET title = ?, body_md = ?, kind = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`, [v.title, v.body_md, v.kind, ts, noteId]);
    if (v.kind === 'checklist') {
      await _tombstoneItems(noteId, ts);
      const items = v.items_json ? JSON.parse(v.items_json) : [];
      for (let i = 0; i < items.length; i++) await _upsertItem(noteId, { text: items[i].text, checked: items[i].checked, position: i + 1 }, ts);
    }
    return _note(noteId);
  },

  // Labels

  async getLabels() {
    return _q(
      `SELECT l.id, l.name, l.color, l.position, l.created_at, l.updated_at,
              (SELECT COUNT(*) FROM note_labels nl JOIN notes n ON n.id = nl.note_id
                WHERE nl.label_id = l.id AND nl.deleted_at IS NULL AND n.deleted_at IS NULL AND n.trashed_at IS NULL) AS note_count
         FROM labels l WHERE l.deleted_at IS NULL ORDER BY l.position ASC, l.name COLLATE NOCASE ASC`);
  },

  async createLabel({ name, color } = {}) {
    const clean = String(name || '').trim().slice(0, 60);
    if (!clean) throw new Error('Label name required');
    const dup = (await _q(`SELECT 1 FROM labels WHERE deleted_at IS NULL AND name = ? COLLATE NOCASE`, [clean]))[0];
    if (dup) throw new Error('A label with that name already exists');
    const max = (await _q(`SELECT MAX(position) AS p FROM labels WHERE deleted_at IS NULL`))[0];
    const ts = _now();
    const id = await _insert(
      `INSERT INTO labels (user_id, name, color, position, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [LOCAL_USER_ID, clean, color || null, (max?.p || 0) + 1, ts, ts]);
    return (await NotesNative.getLabels()).find(l => l.id === id);
  },

  async updateLabel(id, { name, color } = {}) {
    id = Number(id);
    const row = (await _q(`SELECT * FROM labels WHERE id = ? AND deleted_at IS NULL`, [id]))[0];
    if (!row) throw new Error('Label not found');
    const next = name !== undefined ? String(name).trim().slice(0, 60) : row.name;
    if (!next) throw new Error('Label name required');
    const dup = (await _q(`SELECT 1 FROM labels WHERE deleted_at IS NULL AND name = ? COLLATE NOCASE AND id != ?`, [next, id]))[0];
    if (dup) throw new Error('A label with that name already exists');
    await _run(`UPDATE labels SET name = ?, color = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`,
      [next, color !== undefined ? (color || null) : row.color, _now(), id]);
    return (await NotesNative.getLabels()).find(l => l.id === id);
  },

  async deleteLabel(id) {
    id = Number(id);
    const ts = _now();
    await _run(`UPDATE note_labels SET deleted_at = ?, updated_at = ?, sync_status = 'pending' WHERE label_id = ? AND deleted_at IS NULL`, [ts, ts, id]);
    await _run(`UPDATE labels SET deleted_at = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`, [ts, ts, id]);
    return { ok: true };
  },

  async reorderLabels(ids = []) {
    const ts = _now();
    for (let i = 0; i < ids.length; i++) {
      await _run(`UPDATE labels SET position = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`, [i + 1, ts, Number(ids[i])]);
    }
    return NotesNative.getLabels();
  },

};
