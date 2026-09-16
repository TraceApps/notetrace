import { writable } from 'svelte/store';

/** Global confirm-dialog store.
 *
 *  Usage from any component:
 *    import { confirmDialog } from '../../stores/confirmDialog.js';
 *    if (!await confirmDialog({ title: 'Delete?', message: '...', dangerous: true })) return;
 *
 *  With `input` ({ value, placeholder, maxlength, label }) it asks for a line
 *  of text and resolves to what was typed (trimmed), or null when cancelled.
 *
 *  A single <ConfirmDialogMount /> instance (mounted in App.svelte) renders
 *  the Dialog and resolves the awaiting promise on user action.
 */

export const confirmRequest = writable(null);

export function confirmDialog({
  title = 'Are you sure?',
  message = '',
  confirmText = 'OK',
  cancelText = 'Cancel',
  dangerous = false,
  input = null,
} = {}) {
  return new Promise(resolve => {
    confirmRequest.set({ title, message, confirmText, cancelText, dangerous, input, resolve });
  });
}

/** Ask for a line of text. Resolves to the trimmed text, or null. */
export function promptDialog({ value = '', placeholder = '', maxlength = 200, label = '', ...rest } = {}) {
  return confirmDialog({ ...rest, input: { value, placeholder, maxlength, label } });
}
