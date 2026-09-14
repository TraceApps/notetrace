/**
 * memos.js: notes from a Memos server, through its API.
 *
 * Memos has no export file, so NoteTrace reads your memos straight from
 * your Memos server with a personal access token (Memos: Settings, My
 * Account, Access Tokens). The token is used from this browser or phone
 * only and isn't saved. Memos' API allows token requests from any origin,
 * so this works on the web and in the Android app alike.
 *
 * Imported per memo: content (Markdown), tags, pinned, archived, created
 * and updated times, and image attachments. Only your own memos are
 * imported, not other people's public ones, and comments are skipped.
 * Covers the current API (state, attachments) and older versions
 * (rowStatus, resources).
 */
import { parseMarkdownNote, toSqlTs } from './markdown.js';

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i;

/** Normalize what the user typed as the server address. */
export function memosBaseUrl(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, '');
}

function _attachmentPath(a) {
  const name = String(a?.name || '');
  const filename = encodeURIComponent(a?.filename || '');
  if (name.startsWith('attachments/')) return `/file/${name}/${filename}`;
  if (name.startsWith('resources/')) return `/file/${name}/${filename}`;
  if (a?.uid) return `/file/resources/${a.uid}/${filename}`;
  if (a?.id) return `/o/r/${a.id}`;
  return null;
}

/**
 * One memo to a normalized note, or null when it should be skipped.
 * `userName` is the importing account's resource name ("users/1").
 * Returns { note, otherFiles } where otherFiles counts non-image attachments.
 */
export function parseMemo(memo, { userName = '' } = {}) {
  if (!memo || typeof memo.content !== 'string') return null;
  if (memo.parent) return null; // a comment on another memo
  if (userName && memo.creator && memo.creator !== userName) return null;
  const state = memo.state || memo.rowStatus || 'NORMAL';
  if (state !== 'NORMAL' && state !== 'ARCHIVED' && state !== 'ACTIVE') return null;

  const note = parseMarkdownNote('memo.md', memo.content, { tagsToLabels: true });
  const files = [];
  let otherFiles = 0;
  let links = '';
  for (const a of [...(memo.attachments || []), ...(memo.resources || [])]) {
    const isImage = /^image\//i.test(String(a?.type || '')) || IMAGE_RE.test(String(a?.filename || ''));
    if (a?.externalLink) {
      links += `${links ? '  \n' : ''}[${String(a.filename || a.externalLink).replace(/[[\]]/g, '')}](${a.externalLink})`;
      continue;
    }
    const path = _attachmentPath(a);
    if (isImage && path) files.push({ path, name: a.filename });
    else otherFiles++;
  }
  if (!note && !files.length && !links) return null;

  const out = note || {
    title: '', body_md: '', kind: 'text', items: [], color: null, pinned: false, archived: false,
    trashed: false, labels: [], created_at: null, updated_at: null, reminder_at: null, reminder_rrule: null, reminder_tz: null, files: [],
  };
  if (links) {
    if (out.kind === 'checklist') out.items.push(...links.split('  \n').map(text => ({ text, checked: false })));
    else out.body_md = out.body_md ? `${out.body_md}\n\n${links}` : links;
  }
  for (const t of Array.isArray(memo.tags) ? memo.tags : []) {
    const clean = String(t).replace(/^#/, '').trim().slice(0, 60);
    if (clean && !out.labels.some(l => l.toLowerCase() === clean.toLowerCase())) out.labels.push(clean);
  }
  out.files = files;
  out.pinned = !!memo.pinned;
  out.archived = state === 'ARCHIVED';
  out.created_at = toSqlTs(memo.createTime || memo.displayTime || null) || out.created_at;
  out.updated_at = toSqlTs(memo.updateTime || null) || out.created_at;
  return { note: out, otherFiles };
}

async function _get(base, token, path) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) throw new Error('memos_auth');
  if (!res.ok) throw new Error(`memos_http_${res.status}`);
  return res.json();
}

/**
 * Read every memo the token's account owns. Resolves
 * { notes, attachments, readFile, count }. Throws Error('memos_auth') for a
 * bad token and Error('memos_unreachable') when the server can't be reached.
 */
export async function fetchMemos(rawUrl, token, onProgress) {
  // An address typed without a scheme tries https, then http (a LAN Memos).
  const typedScheme = /^https?:\/\//i.test(String(rawUrl || '').trim());
  const candidates = typedScheme ? [memosBaseUrl(rawUrl)] : [memosBaseUrl(rawUrl), memosBaseUrl(`http://${String(rawUrl).trim()}`)];
  let base = '';
  let me = null;
  let authFailed = false;
  for (const candidate of candidates) {
    try {
      me = await _get(candidate, token, '/api/v1/auth/me').catch(async (e) => {
        if (e.message === 'memos_auth') throw e;
        return _get(candidate, token, '/api/v1/auth/status'); // older versions
      });
      base = candidate;
      break;
    } catch (e) {
      if (e.message === 'memos_auth') { authFailed = true; break; }
    }
  }
  if (authFailed) throw new Error('memos_auth');
  if (!base) throw new Error('memos_unreachable');
  const userName = me?.user?.name || me?.name || '';

  const seen = new Set();
  const notes = [];
  let attachments = 0;
  for (const state of ['NORMAL', 'ARCHIVED']) {
    let pageToken = '';
    for (let page = 0; page < 500; page++) {
      const q = new URLSearchParams({ pageSize: '200', state });
      if (pageToken) q.set('pageToken', pageToken);
      const data = await _get(base, token, `/api/v1/memos?${q}`);
      for (const memo of data.memos || []) {
        if (!memo?.name || seen.has(memo.name)) continue;
        seen.add(memo.name);
        const r = parseMemo(memo, { userName });
        if (!r) continue;
        attachments += r.otherFiles;
        notes.push(r.note);
      }
      onProgress?.(seen.size);
      pageToken = data.nextPageToken || '';
      if (!pageToken) break;
    }
  }

  async function readFile(ref) {
    if (!ref?.path) return null;
    try {
      const res = await fetch(`${base}${ref.path}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return null;
      const blob = await res.blob();
      const name = ref.name || ref.path.split('/').pop();
      return new File([blob], name, { type: blob.type || 'image/jpeg' });
    } catch {
      return null;
    }
  }
  return { notes, attachments, unreadable: 0, trashedSkipped: 0, readFile, count: seen.size };
}
