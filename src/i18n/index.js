import { addMessages, register, init, getLocaleFromNavigator } from 'svelte-i18n';
import en from './en.json';

// UI text lives in en.json and renders through $_(). English is bundled and
// added up front, so the locale is ready before the first render and nobody
// ever sees a raw key. Other languages (Weblate writes them into this folder)
// load on demand: register them below and add an entry to AVAILABLE_LOCALES,
// and the picker in Settings, Regional offers the new option. Same shape as
// the other Trace apps, which register every locale lazily.
addMessages('en', en);

// register('sv', () => import('./sv.json'));

export const AVAILABLE_LOCALES = [
  { code: 'en', label: 'English' },
];

export function initI18n(initialLocale) {
  init({
    fallbackLocale: 'en',
    initialLocale: initialLocale || pickInitialLocale(),
    // Missing-key warnings would spam the console for anyone running a locale
    // that isn't fully translated, so they stay in dev builds.
    warnOnMissingMessages: !!import.meta.env.DEV,
  });
}

/** The browser's language when it's one we ship, English otherwise. */
function pickInitialLocale() {
  const nav = getLocaleFromNavigator();
  if (!nav) return 'en';
  const short = nav.split('-')[0];
  return AVAILABLE_LOCALES.some(l => l.code === short) ? short : 'en';
}
