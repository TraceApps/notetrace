import { addMessages, init } from 'svelte-i18n';
import en from './en.json';

// NoteTrace is English only. UI text still lives in en.json and renders
// through $_() so copy stays in one place. The messages are added up front
// (not lazy-loaded) so the locale is ready before the first render.
addMessages('en', en);

export function initI18n() {
  init({
    fallbackLocale: 'en',
    initialLocale: 'en',
    warnOnMissingMessages: !!import.meta.env.DEV,
  });
}
