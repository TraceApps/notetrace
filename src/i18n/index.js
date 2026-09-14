import { register, init } from 'svelte-i18n';

// NoteTrace is English only. UI text still lives in en.json and renders
// through $_() so copy stays in one place, but no other languages ship.
register('en', () => import('./en.json'));

export function initI18n() {
  init({
    fallbackLocale: 'en',
    initialLocale: 'en',
    warnOnMissingMessages: !!import.meta.env.DEV,
  });
}
