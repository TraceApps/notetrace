import { writable } from 'svelte/store';

/** Global confirm-dialog store.
 *
 *  Usage from any component:
 *    import { confirmDialog } from '../../stores/confirmDialog.js';
 *    if (!await confirmDialog({ title: 'Delete?', message: '...', dangerous: true })) return;
 *
 *  With `input` ({ value, placeholder, maxlength, label }) it asks for a line
 *  of text and resolves to what was typed (trimmed), or null when cancelled.
 *  With allowEmpty, confirming an empty box resolves to '' instead of null.
 *
 *  With `dismissed` set, closing the dialog without an answer (Back,
 *  Escape, a tap outside) resolves to that value instead of false, for
 *  questions where Cancel is itself an answer.
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
  ...rest
} = {}) {
  return new Promise(resolve => {
    confirmRequest.set({ title, message, confirmText, cancelText, dangerous, input, resolve, ...('dismissed' in rest ? { dismissed: rest.dismissed } : {}) });
  });
}

/** Ask for a line of text. Resolves to the trimmed text, or null. */
export function promptDialog({ value = '', placeholder = '', maxlength = 200, label = '', allowEmpty = false, type = 'text', ...rest } = {}) {
  return confirmDialog({ ...rest, input: { value, placeholder, maxlength, label, allowEmpty, type } });
}
