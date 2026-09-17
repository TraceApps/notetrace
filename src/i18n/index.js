import { register, init, getLocaleFromNavigator } from 'svelte-i18n';

// UI text lives in en.json and renders through $_(). English is the only
// language shipped today; as translations arrive (Weblate writes them into
// this folder), register them here and add an entry to AVAILABLE_LOCALES so
// the picker in Settings, Regional offers the new option. Same shape as the
// other Trace apps.
register('en', () => import('./en.json'));

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

function pickInitialLocale() {
  const nav = getLocaleFromNavigator();
  if (!nav) return 'en';
  const short = nav.split('-')[0];
  return AVAILABLE_LOCALES.some(l => l.code === short) ? short : 'en';
}
