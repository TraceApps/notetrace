/**
 * note-sharing.js: when sharing is available, and how the UI reads a
 * note's share fields (share_role / share_owner / share_count).
 */
import { derived } from 'svelte/store';
import { isNative, getServerUrl } from './platform.js';
import { userMgmtActive } from '../stores/auth.js';

/** Sharing needs user accounts on a server (not local mode, not single-user). */
export const sharingAvailable = derived(userMgmtActive, ($active) => !!$active && (!isNative || !!getServerUrl()));

export const roleOf = (note) => note?.share_role || 'owner';
export const isOwner = (note) => roleOf(note) === 'owner';
export const canEdit = (note) => roleOf(note) !== 'view';
export const isShared = (note) => !!note && (roleOf(note) !== 'owner' || (note.share_count || 0) > 0);

/**
 * The id the server knows a note by. On Android the note is a local copy
 * with its own id, and sharing calls go to the server, so they need the
 * server's. A note not sent yet is synced first.
 */
export async function serverNoteId(noteId) {
  if (!isNative) return noteId;
  const { NoteApiNative } = await import('./api-native.js');
  let note = await NoteApiNative.getNote(noteId);
  if (!note?.server_id) {
    const { fullSync } = await import('./sync.js');
    await fullSync(true);
    note = await NoteApiNative.getNote(noteId);
  }
  return note?.server_id ?? null;
}

/** After a sharing change on Android, sync so the local copy catches up. */
export async function syncAfterShareChange() {
  if (!isNative) return;
  try {
    const { fullSync } = await import('./sync.js');
    await fullSync(true);
  } catch { /* the regular sync loop picks it up */ }
}
