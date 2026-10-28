// Install console.* wrappers BEFORE any other import logs anything,
// so the in-app diagnostic-log buffer captures the full app lifecycle.
import { setAppVersion } from './lib/log-capture.js';
import { APP_VERSION } from './lib/version.js';
if (typeof window !== 'undefined') window.__APP_VERSION__ = APP_VERSION;
setAppVersion(APP_VERSION);

import './styles/tokens.css';
import './styles/base.css';
import './styles/typography.css';
import './styles/animations.css';
import './styles/buttons.css';
import './styles/forms.css';
import './styles/fold.css';
import App from './App.svelte';
import { applyBannerText } from './stores/settings.js';
import { DB } from './lib/db.js';
import { initI18n } from './i18n/index.js';
import { Capacitor } from '@capacitor/core';
import { installPlainHttpGuard } from './lib/plain-http-guard.js';
import { mediaPolicy } from './lib/plain-http.js';
import { publicNoteToken } from './lib/platform.js';

// Android app: plain http:// only to a confirmed server on your own network
// (lib/plain-http.js, from TraceApps/nutritrace#194). The fetch and
// XMLHttpRequest guard goes in before the app starts (no module keeps its own
// copy of fetch when it loads); images, audio, video and frames get the same
// rule as a Content-Security-Policy.
if (Capacitor.isNativePlatform()) {
  installPlainHttpGuard();
  const csp = document.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = mediaPolicy();
  document.head.prepend(csp);
}

initI18n();

// The system's light or dark is followed only when the choice saved for this
// account is System (DB.getSetting, as the settings store reads it). The
// browser bar keeps the accent's color, as applyAppearance leaves it; only
// before an accent is set does it take the theme's own.
function followSystemTheme(e) {
  if (DB.getSetting('appearance', 'system') !== 'system') return;
  document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
  const meta = document.getElementById('theme-color-meta');
  if (meta && ['#0A0B0F', '#F5F7FA'].includes(meta.content)) meta.content = e.matches ? '#0A0B0F' : '#F5F7FA';
  applyBannerText();
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', followSystemTheme);

// A public note link (/n/<token>) opens on its own: no sign-in, no local
// database, no sync, just the note.
const publicToken = publicNoteToken();
if (publicToken) {
  import('./routes/PublicNote.svelte').then(({ default: PublicNote }) => {
    new PublicNote({ target: document.getElementById('app'), props: { token: publicToken } });
  });
} else {
  boot();
}

function boot() {
  DB.init()
    .then(async () => {
      // Local SQLite layer: open the connection + run the schema before the
      // app mounts so the first NoteApi call has a working DB underneath it.
      // No-op on web. Lazy on subsequent calls because getDb() memoises.
      const { isNative } = await import('./lib/platform.js');
      if (isNative) {
        const { dbInit } = await import('./lib/db-native.js');
        await dbInit();
        const { loadImageMap } = await import('./lib/platform.js');
        await loadImageMap();
      }
      new App({ target: document.getElementById('app') });
    })
    .catch(err => {
      console.error('DB init failed:', err);
      document.getElementById('app').innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                    height:100dvh;padding:32px;text-align:center;gap:16px;font-family:sans-serif;">
          <span style="font-size:48px">⚠️</span>
          <h2 style="color:#F0F2F8">Database Error</h2>
          <p style="color:rgba(240,242,248,0.6);max-width:300px">
            Could not open the local database. Try closing other tabs or clearing site data.
          </p>
          <button onclick="location.reload()"
            style="padding:12px 24px;border-radius:12px;background:#B69CFF;
                   color:#0A0B0F;font-weight:600;border:none;cursor:pointer;font-size:15px;">
            Retry
          </button>
        </div>`;
    });
}
