/**
 * NoteTrace's secrets in user settings (lib/secret-settings.js). The
 * CookTrace link's token is kept apart (lib/cooktrace.js, server-only keys).
 *
 * WRITE_ONLY: only the server uses them, so they're never sent back.
 * ENCRYPTED: the app uses them itself (it calls the AI provider directly),
 * so the account's own app still gets them.
 */
export const WRITE_ONLY_SETTINGS = new Set(['ntfyToken', 'gotifyToken']);
export const ENCRYPTED_SETTINGS = new Set(['aiApiKey']);
