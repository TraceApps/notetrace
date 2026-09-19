/**
 * blinko.js: notes from a Blinko backup (.bko).
 *
 * Settings, Import & Export, Backup in Blinko writes a zip of its data
 * folder: pgdump/bak.json holds every note, and files/ holds the uploaded
 * attachments. A backup covers every account on that Blinko server, so the
 * importer takes the account matching your NoteTrace username, or the only
 * account when there's just one.
 *
 * Blinko keeps tags inside the note text (#tag), so labels come from the
 * content. Pinned (isTop), archived, dates, and image attachments come
 * across. Blinko's backup doesn't say which notes are in its trash, so
 * those come across as regular notes. Blinko's own Markdown export
 * (note-<id>-<time>.md with images in files/) goes through the Markdown
 * importer instead.
 */
import { extractImageEmbeds, inlineTags, toSqlTs, NOTE_COLORS } from './markdown.js';

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i;

export function isBlinkoBackup(data) {
  return !!data && Array.isArray(data.notes) && data.notes.every(n => n && typeof n.content === 'string');
}

/** Account names in a backup, most notes first. */
export function blinkoAccounts(data) {
  const counts = new Map();
  for (const n of data?.notes || []) {
    const name = n.account?.name;
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

/**
 * Parse bak.json. options.username picks the account in a multi-account
 * backup. Returns { notes, attachments, trashedSkipped, accounts, account }.
 * `account` is null when the backup has several accounts and none matches,
 * in which case nothing is imported.
 */
export function parseBlinkoBackup(data, { username = '', includeTrashed = false } = {}) {
  const accounts = blinkoAccounts(data);
  const wanted = String(username || '').toLowerCase();
  const account = accounts.length <= 1 ? (accounts[0] || null)
    : (accounts.find(a => a.toLowerCase() === wanted) || null);
  const out = { notes: [], attachments: 0, trashedSkipped: 0, accounts, account };
  if (accounts.length > 1 && !account) return out;

  for (const n of data.notes) {
    if (account && n.account?.name && n.account.name !== account) continue;
    if (n.isRecycle && !includeTrashed) { out.trashedSkipped++; continue; }
    const { body, files } = extractImageEmbeds('', n.content);
    const images = [];
    for (const a of Array.isArray(n.attachments) ? n.attachments : []) {
      const name = String(a?.name || a?.path || '').split('/').pop();
      if (!name) { out.attachments++; continue; }
      const type = String(a?.type || '').toLowerCase();
      // Pictures by name; anything else (a PDF, a document) carries its type along.
      if (IMAGE_RE.test(name) || /^image\//.test(type)) images.push({ name });
      else images.push({ name, mime: type || 'application/octet-stream' });
    }
    // Image embeds that point at an attachment already listed aren't added twice.
    const seen = new Set(images.map(i => i.name.toLowerCase()));
    for (const f of files) {
      const name = String(f.name || f.path || '').split('/').pop();
      if (name && !seen.has(name.toLowerCase())) { images.push({ name }); seen.add(name.toLowerCase()); }
    }
    const text = body.trim();
    const lines = text.split('\n').filter(l => l.trim());
    const allTasks = lines.length > 0 && lines.every(l => /^\s*[-*+]\s+\[[ xX]\]/.test(l));
    const note = {
      title: '',
      body_md: allTasks ? '' : text,
      kind: allTasks ? 'checklist' : 'text',
      items: allTasks
        ? lines.map(l => { const m = l.match(/^\s*[-*+]\s+\[([ xX])\]\s?(.*)$/); return { text: m[2].trim(), checked: m[1].toLowerCase() === 'x' }; }).filter(i => i.text)
        : [],
      color: NOTE_COLORS.includes(n.metadata?.color) ? n.metadata.color : null,
      pinned: !!n.isTop && !n.isArchived,
      archived: !!n.isArchived,
      trashed: !!n.isRecycle,
      labels: inlineTags(text).map(t => t.slice(0, 60)),
      created_at: toSqlTs(n.createdAt),
      updated_at: toSqlTs(n.updatedAt) || toSqlTs(n.createdAt),
      reminder_at: null,
      reminder_rrule: null,
      reminder_tz: null,
      files: images,
    };
    if (!note.body_md && !note.items.length && !images.length) continue;
    out.notes.push(note);
  }
  return out;
}
