import { writable } from 'svelte/store';

export const toasts = writable([]);

let _id = 0;

export function showToast(message, duration = 3000, type = 'default', action = null) {
  const id = ++_id;
  toasts.update(list => [...list, { id, message, type, action }]);
  setTimeout(() => {
    toasts.update(list => list.filter(t => t.id !== id));
  }, duration);
  return id;
}

export function dismissToast(id) {
  toasts.update(list => list.filter(t => t.id !== id));
}

/** A toast with a button, e.g. showUndo('Archived', () => restore()). */
export function showUndo(msg, run, label = 'Undo') {
  const id = showToast(msg, 6000, 'info', { label, run: () => { dismissToast(id); run(); } });
  return id;
}

export function showSuccess(msg) { showToast(msg, 2500, 'success'); }
export function showError(msg)   { showToast(msg, 4000, 'error'); }
export function showInfo(msg)    { showToast(msg, 3000, 'info'); }
