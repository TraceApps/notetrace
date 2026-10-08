import { writable, get, derived } from 'svelte/store';
import { DB } from '../lib/db.js';

const _dlog = import.meta.env.DEV
  ? console.log
  : (...a) => { try { if (localStorage.getItem('note:verboseLogging') === '1') console.log(...a); } catch {} };

// ── Settings categorization ────────────────────────────────────────────────
//
// USER_PREFS — synced to server, travel with the user across devices.
// DEVICE_PREFS — local-only, never synced.
// SERVER_ADMIN — server-only (filtered in server/lib/server-only-keys.js).
//
export const USER_PREFS = new Set([
  // Locale + display
  'accentColor','pageBanners','bannerStyle','bannerAnimation','startPage',
  'language','dateFormat','timeFormat','timezone',
  // AI Assistant ("Trace" persona)
  'aiEnabled','aiProvider','aiApiKey','aiModel','aiBaseUrl','aiAssistantName','aiKeyVerified',
  // Smart Log (hold-to-record on the FAB → AI parses spoken intent → tool execution)
  'smartLogEnabled',
  // Language the Smart Log microphone listens for ('auto' = device locale)
  'smartLogVoiceLang',
  // Voice notes and images: automatic transcription / reading text with Trace
  'autoTranscribe','autoSummarizeLong','autoReadImages','aiTranscribeModel',
  // Note cards
  'linkPreviews', 'noteSort', 'noteOrder',
  'watchNotes',
  'labelOrder',
  'noteTemplates',
  'tasksGroupBy', 'tasksAllChecklists',
  // Notifications
  'notifPushService',
  'appriseUrl','appriseTag','gotifyUrl','gotifyToken','ntfyUrl','ntfyTopic','ntfyToken',
  'notifNoteReminders',
  'notifTasksDue', 'tasksDigestTime',
  // Hours between automatic update checks: 1, 4, 12, 24, or 0 for manual only.
  'updateCheckInterval',
]);

export const DEVICE_PREFS = new Set([
  'appearance','navStyle','sidebarPersistent','disableAnimations',
  'sidebarRail', 'sidebarLabelsCollapsed', // per-device sidebar shape
  'sidebarRailMedium',     // Auto navigation on a medium screen (an unfolded foldable): sidebar as icons
  'keyboardShortcuts',     // single-key shortcuts on this device
  'cardDensity',           // 'comfortable' or 'compact' note cards
  'labelTreeCollapsed',    // nested label groups folded in the sidebar
  'swipeToArchive',        // swipe a card sideways on a touch screen
  'voicePlaybackRate',     // voice note play speed on this device
  'forceMobileLayout',     // per-device layout opt-out (mirrors NT/LT)
  'biometricLoginEnabled', // Android-only, per-device biometric unlock for sign-in
  'appLockEnabled',        // Android-only: require biometric / device credential to open the app
  'appLockTimeoutMin',     // minutes in the background before the lock re-engages (0 = immediately)
  'notifLocalEnabled',     // reminder notifications on this device (phone, or this browser while open)
  'notesLayout',           // 'grid', 'list', or 'timeline' on the notes screens (the last one picked)
  'notesLayoutBySize',     // the layout picked for each size class, so a foldable's two screens keep their own
  'listGroupBy',           // List layout sections: 'none', 'label', 'color', 'date'
  'listColumnWidth',       // List layout: width of the list column beside the reading pane, px
]);

const SERVER_SETTINGS = USER_PREFS;

import { isNative, getServerUrl, getAuthToken, apiUrl } from '../lib/platform.js';

function _settingsUrl() { return apiUrl('/api/settings'); }

function _authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (isNative && getServerUrl()) {
    const token = getAuthToken();
    if (token) h['Authorization'] = `Bearer ${token}`;
  } else if (!isNative) {
    const csrf = localStorage.getItem('note:csrf');
    if (csrf) h['X-CSRF-Token'] = csrf;
  }
  return h;
}

const _saveQueue = {};
const _recentlyChanged = new Map();
export function isRecentlyChanged(key) {
  const ts = _recentlyChanged.get(key);
  return ts && Date.now() - ts < 10000;
}
let _suppressSync = false;

export function _applySetting(key, value) {
  _suppressSync = true;
  DB.setSetting(key, value);
  _suppressSync = false;
}

function _isLoggedIn() { return !!localStorage.getItem('wl:userId'); }
function _shouldSyncToServer() { return _isLoggedIn() && !(isNative && !getServerUrl()); }

// ── The phone's copy of the settings (Android) ───────────────────────────
// Every setting change also waits in the phone's copy (SQLite user_settings)
// until it reaches the server. That copy is one account's: until the
// account check has passed (lib/local-account.js), it may still be the
// previous account's, so nothing of this account's goes into it before.
// Checked again before every write: once another account signs in (the
// account generation moves), nothing more goes in.
async function _intoPhoneCopy(write) {
  const forUser = localStorage.getItem('wl:userId');
  const la = await import('../lib/local-account.js');
  if (!(await la.whenLocalCopyIsCurrent(forUser))) return null;
  const gen = la.accountGeneration();
  const live = () => la.accountGeneration() === gen && la.localCopyIsCurrent(forUser)
    && localStorage.getItem('wl:userId') === forUser;
  if (!live()) return null;
  return write(live);
}
function _queueInPhoneCopy(key, value) {
  _intoPhoneCopy(async () => (await import('../lib/db-native.js')).dbUpsertSetting(key, value)).catch(() => {});
}

export function scheduleSave(key, value) {
  if (!SERVER_SETTINGS.has(key)) return;
  if (_suppressSync) return;
  clearTimeout(_saveQueue[key]);
  _saveQueue[key] = setTimeout(async () => {
    if (!_shouldSyncToServer()) return;
    // When the phone's copy of this setting was last changed, before it
    // goes up: if it changes again while this is out, it stays waiting
    // for the next sync instead of being marked as sent.
    let sentAt = null;
    if (isNative) {
      try {
        const la = await import('../lib/local-account.js');
        if (la.localCopyIsCurrent()) sentAt = await (await import('../lib/db-native.js')).dbGetSettingUpdatedAt(key, value);
      } catch { /* not in the copy yet */ }
    }
    try {
      const url = _settingsUrl();
      // Never a value: settings include API keys and tokens.
      _dlog(`[settings] pushing ${key} (changed) to ${url}`);
      const res = await fetch(url, {
        method: 'PUT',
        credentials: 'include',
        headers: _authHeaders(),
        body: JSON.stringify({ key, value }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      if (isNative && sentAt) {
        try {
          const la = await import('../lib/local-account.js');
          if (la.localCopyIsCurrent()) await (await import('../lib/db-native.js')).dbMarkSettingsSynced([{ key, updated_at: sentAt }]);
        } catch {}
      }
    } catch (e) {
      console.warn(`[settings] direct push failed for ${key}:`, e.message);
      // With no connection the change is kept and goes up with everything
      // else, rather than staying local while the server keeps the old value.
      if (!isNative) {
        try {
          const { queueRequest } = await import('../lib/offline-api.js');
          await queueRequest({ kind: `the "${key}" setting`, key: `setting:${key}`, method: 'PUT', path: '/api/settings', body: { key, value } });
        } catch { /* no database to queue into */ }
      }
    }
  }, 600);
}

export async function bulkSet(settingsObj) {
  if (!settingsObj || typeof settingsObj !== 'object') return;
  const entries = Object.entries(settingsObj);
  if (entries.length === 0) return;
  const userPrefEntries = entries.filter(([k]) => USER_PREFS.has(k));

  _suppressSync = true;
  try {
    for (const [key, value] of entries) DB.setSetting(key, value);
  } finally { _suppressSync = false; }

  // When each went into the phone's copy, to mark it sent below.
  const sentAt = new Map();
  if (isNative && userPrefEntries.length > 0) {
    try {
      await _intoPhoneCopy(async (live) => {
        const { dbUpsertSetting } = await import('../lib/db-native.js');
        for (const [key, value] of userPrefEntries) {
          if (!live()) return;
          sentAt.set(key, await dbUpsertSetting(key, value));
        }
      });
    } catch (e) {
      console.warn('[settings] bulk native upsert failed:', e.message);
    }
  }

  if (!_shouldSyncToServer() || userPrefEntries.length === 0) return;
  try {
    const url = _settingsUrl() + '/bulk';
    const bulkObj = Object.fromEntries(userPrefEntries);
    const res = await fetch(url, {
      method: 'PUT',
      credentials: 'include',
      headers: _authHeaders(),
      body: JSON.stringify({ settings: bulkObj }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Server responded ${res.status}`);
    if (isNative && sentAt.size) {
      try {
        const la = await import('../lib/local-account.js');
        if (la.localCopyIsCurrent()) await (await import('../lib/db-native.js')).dbMarkSettingsSynced([...sentAt].map(([key, updated_at]) => ({ key, updated_at })));
      } catch {}
    }
  } catch (e) {
    console.warn('[settings] bulk push failed:', e.message);
  }
}

async function _unsentSettingKeys(forUser) {
  try {
    const la = await import('../lib/local-account.js');
    // The copy is this account's: checked already, or tagged as its own (a
    // sign-in back to the same account, before the check has run).
    if (!la.localCopyIsCurrent(forUser) && !(await la.copyTaggedFor(forUser))) return new Set();
    const { dbGetPendingSettings } = await import('../lib/db-native.js');
    return new Set((await dbGetPendingSettings()).map(s => s.key));
  } catch { return new Set(); }
}

async function _mirrorServerSettings(serverSettings) {
  try {
    await _intoPhoneCopy(async (live) => {
      const { dbMirrorSetting } = await import('../lib/db-native.js');
      for (const [key, value] of Object.entries(serverSettings)) {
        if (DEVICE_PREFS.has(key)) continue;
        if (!live()) return;
        await dbMirrorSetting(key, value);
      }
    });
  } catch (e) {
    console.warn('[settings] native SQLite mirror failed:', e.message);
  }
}

export async function loadServerSettings() {
  if (!_shouldSyncToServer()) return;
  try {
    const res = await fetch(_settingsUrl(), { credentials: 'include', headers: _authHeaders(), signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const serverSettings = await res.json();
    // Settings changed on this phone and not sent yet are the newer ones:
    // kept when the server's come down. Only while the phone's copy is
    // this account's (before, its rows can be the previous account's).
    const forUser = localStorage.getItem('wl:userId');
    const unsent = isNative ? await _unsentSettingKeys(forUser) : new Set();
    _suppressSync = true;
    // CRITICAL: skip DEVICE_PREFS keys. These are local-only (form-factor
    // or hardware specific) and should never be overwritten by server
    // values. Stale rows can exist from before the device-pref filter
    // was added on the write path — without this filter every settings
    // poll would overwrite a tablet's `sidebarPersistent: true` with a
    // phone's `false` and the persistent-sidebar toggle would silently
    // turn off mid-session.
    for (const [key, value] of Object.entries(serverSettings)) {
      if (DEVICE_PREFS.has(key)) continue;
      if (unsent.has(key)) continue; // changed here, not sent yet: the newer value
      DB.setSetting(key, value, true);
    }
    // Into the phone's copy only once it's this account's, and never over
    // a change waiting to go up. In the background, so signing in never
    // waits on the account check.
    if (isNative) _mirrorServerSettings(serverSettings).catch(() => {});
    _suppressSync = false;

    try {
      if (typeof window !== 'undefined') {
        const accent = DB.getSetting('accentColor', 'lavender');
        const appearanceVal = DB.getSetting('appearance', 'system');
        applyAccentColor(accent);
        applyAppearance(appearanceVal);
      }
    } catch {}
  } catch { _suppressSync = false; }
}

// Global wl:setting listener — catches direct DB.setSetting() calls and
// pushes USER_PREFS keys to server. Mirrors the NutriTrace pattern.
if (typeof window !== 'undefined') {
  window.addEventListener('wl:setting', (e) => {
    const key = e.detail?.key;
    if (!key) return;
    if (!USER_PREFS.has(key)) return;
    if (_suppressSync) return;
    const value = DB.getSetting(key, undefined);
    _recentlyChanged.set(key, Date.now());
    if (isNative) _queueInPhoneCopy(key, value);
    scheduleSave(key, value);
  });
}

// Every setting store, so a change of account can make each read its own
// account's value again (reloadSettingStores).
const _settingStores = [];

/**
 * Every setting store reads the value of the account signed in now. A
 * store keeps the last value it read, so after a sign-out and another
 * account's sign-in it would show, and could save, the previous account's.
 * `force` also drops changes still waiting to be sent (the previous
 * account's). Called on every change of account (lib/user-state.js).
 */
export function reloadSettingStores({ force = false } = {}) {
  if (force) {
    for (const k of Object.keys(_saveQueue)) { clearTimeout(_saveQueue[k]); delete _saveQueue[k]; }
    _recentlyChanged.clear();
  }
  for (const { key, defaultValue, store } of _settingStores) {
    const next = DB.getSetting(key, defaultValue);
    if (JSON.stringify(get(store)) !== JSON.stringify(next)) store.set(next);
  }
}

function createSettingStore(key, defaultValue) {
  const store = writable(DB.getSetting(key, defaultValue));
  _settingStores.push({ key, defaultValue, store });

  window.addEventListener('wl:setting', (e) => {
    if (e.detail && e.detail.key === key) {
      const next = DB.getSetting(key, defaultValue);
      const prev = get(store);
      if (JSON.stringify(prev) !== JSON.stringify(next)) store.set(next);
    }
  });

  return {
    subscribe: store.subscribe,
    set(value) {
      const current = DB.getSetting(key, defaultValue);
      if (JSON.stringify(current) === JSON.stringify(value)) {
        store.set(value);
        return;
      }
      DB.setSetting(key, value);
      store.set(value);
      if (_suppressSync) return;
      _recentlyChanged.set(key, Date.now());
      if (isNative && SERVER_SETTINGS.has(key)) _queueInPhoneCopy(key, value);
      scheduleSave(key, value);
    },
    update(fn) {
      const current = DB.getSetting(key, defaultValue);
      this.set(fn(current));
    },
    get() { return get(store); }
  };
}

// ── Device prefs (local-only) ──────────────────────────────────────────────
export const appearance        = createSettingStore('appearance',        'system');
// 'auto' fits the screen: tab bar on phones, icons on an unfolded foldable, sidebar on desktop.
export const navStyle          = createSettingStore('navStyle',          'auto');
export const sidebarPersistent = createSettingStore('sidebarPersistent', true);
// Pinned desktop sidebar collapsed to an icon rail, and the Labels section folded.
export const sidebarRail = createSettingStore('sidebarRail', false);
export const sidebarRailMedium = createSettingStore('sidebarRailMedium', true);
export const sidebarLabelsCollapsed = createSettingStore('sidebarLabelsCollapsed', false);
// Off unless the device asks for reduced motion; the setting overrides it either way.
export const disableAnimations = createSettingStore('disableAnimations', typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
export const biometricLoginEnabled = createSettingStore('biometricLoginEnabled', false);
export const appLockEnabled    = createSettingStore('appLockEnabled',    false);
export const notesLayout       = createSettingStore('notesLayout',       'grid');
export const notesLayoutBySize = createSettingStore('notesLayoutBySize', {});
export const listGroupBy       = createSettingStore('listGroupBy',       'none');
export const listColumnWidth   = createSettingStore('listColumnWidth',   360);
export const linkPreviews      = createSettingStore('linkPreviews',      true);
// 'edited' (newest edit first) or 'custom' (the order you dragged notes into).
export const noteSort          = createSettingStore('noteSort',          'edited');
export const noteOrder         = createSettingStore('noteOrder',         []);
// Labels in the sidebar and pickers: 'alpha' (A to Z), 'used' (most notes first), or 'custom' (dragged in Edit Labels).
export const labelOrder        = createSettingStore('labelOrder',        'alpha');
// Note ids to keep on a Wear OS watch. Empty means all of them.
export const watchNotes        = createSettingStore('watchNotes',        []);
// Notes to start from (src/lib/note-templates.js).
export const noteTemplates     = createSettingStore('noteTemplates',     []);
export const keyboardShortcuts = createSettingStore('keyboardShortcuts', true);
// Tasks view: 'due' (by due date) or 'note'.
export const tasksGroupBy      = createSettingStore('tasksGroupBy',      'due');
// Tasks shows every open item from every checklist, not just dated items and lists shown in Tasks.
export const tasksAllChecklists = createSettingStore('tasksAllChecklists', false);
export const cardDensity       = createSettingStore('cardDensity',       'comfortable');
export const labelTreeCollapsed = createSettingStore('labelTreeCollapsed', []);
export const swipeToArchive    = createSettingStore('swipeToArchive',    true);
export const voicePlaybackRate = createSettingStore('voicePlaybackRate', 1);
export const appLockTimeoutMin = createSettingStore('appLockTimeoutMin', 1);
// Force-mobile layout: keep the mobile single-column pattern even on
// wide viewports. Gates every desktop @media rule via the
// :global(html:not(.force-mobile-layout)) prefix in Settings. Off by
// default; the App.svelte reactive toggles the .force-mobile-layout
// class on <html> so any future desktop-only layout can opt in.
export const forceMobileLayout = createSettingStore('forceMobileLayout', false);

// ── User prefs (server-synced) ─────────────────────────────────────────────
export const accentColor = createSettingStore('accentColor', 'lavender');
// Page banners — three styles:
//   'animated' = tall header with the page's illustrated SVG
//   'gradient' = compact header filled with the active accent gradient (default)
//   'off'      = compact header, no decoration
// `pageBanners` is kept as a derived alias so existing call sites (route
// has-banner class, padding maths) continue to mean "show the tall illustrated
// header layout" — true ONLY for 'animated'.
//
// Migration matrix:
//   - Saved bannerStyle → keep the explicit pick (any return user who's been
//     in Settings → Appearance since the gradient setting shipped).
//   - Legacy pageBanners=false → 'off' (user explicitly hid banners; respect it).
//   - Anything else (including the legacy default pageBanners=true) → 'gradient',
//     since the prior 'true' default was never an explicit "I want the
//     illustrated banner" choice. Resolved value is persisted so subsequent
//     boots short-circuit to the saved-pick path.
function _migrateBannerStyle() {
  const saved = DB.getSetting('bannerStyle', null);
  if (saved != null) return saved;
  // Legacy pageBanners=false → 'off' (respect explicit opt-out).
  // Anything else → 'animated' (preserve the existing-user experience).
  // New users completing the Wizard get 'gradient' written into their
  // settings batch by finish() — that's a 100%-reliable "this is a new
  // install" signal that doesn't require scraping localStorage. Mirrors
  // LiftTrace d24bed5.
  if (DB.getSetting('pageBanners', true) === false) return 'off';
  return 'animated';
}
export const bannerStyle = createSettingStore('bannerStyle', _migrateBannerStyle());
// pageBanners is now a legacy derived alias. Illustrated SVG banners were
// retired (mirrors LiftTrace's banner rebuild). Kept around as
// `bannerStyle !== 'off'` for any downstream code still importing it.
export const pageBanners = derived(bannerStyle, $s => $s !== 'off');
// bannerAnimation picks which CSS animation applies when bannerStyle is
// 'animated'. Four styles: 'shimmer' (default), 'drift', 'pulse', 'aurora'.
export const bannerAnimation = createSettingStore('bannerAnimation', 'shimmer');
export const startPage   = createSettingStore('startPage',   '/');
// UI language. English is the only one shipped today; translations register
// themselves in src/i18n/index.js as they arrive.
export const language    = createSettingStore('language',    'en');
export const dateFormat  = createSettingStore('dateFormat',  'US');
export const timeFormat  = createSettingStore('timeFormat',  '12h');
export const timezone    = createSettingStore('timezone',    '');

// AI Assistant ("Trace" persona)
export const aiEnabled       = createSettingStore('aiEnabled',       false);
// Server-driven env-lock state. Populated from /api/app-config/env-locks
// at app startup. Mirrors NutriTrace #36 fix so AI_ENABLED=true in env
// actually enables the assistant.
export const envLocks = writable({ smtp: false, ai: false, ai_enabled: false, oidc_provider_ids: [] });
export const aiEffectivelyEnabled = derived(
  [aiEnabled, envLocks],
  ([$aiEnabled, $envLocks]) => !!$aiEnabled || (!!$envLocks.ai && !!$envLocks.ai_enabled)
);
export const aiProvider      = createSettingStore('aiProvider',      'claude');
export const aiApiKey        = createSettingStore('aiApiKey',        '');
export const aiModel         = createSettingStore('aiModel',         '');
export const aiBaseUrl       = createSettingStore('aiBaseUrl',       '');
export const aiAssistantName = createSettingStore('aiAssistantName', 'Trace');
// True after a successful "Test" in Settings → Trace. The Trace FAB
// only shows when this flips on (or when the AI is env-locked, since
// the admin has already validated the key). Cleared whenever the user
// changes provider / api key / model / base URL so they can't sail
// past a stale "verified" status.
export const aiKeyVerified  = createSettingStore('aiKeyVerified',  false);
// Smart Log: hold-to-record on the FAB → AI parses spoken intent →
// tidies the dictation into a note.
// Defaults off; user enables explicitly in Settings → Trace.
export const smartLogEnabled = createSettingStore('smartLogEnabled', false);
// Language the Smart Log microphone listens for. 'auto' follows the device locale.
export const smartLogVoiceLang = createSettingStore('smartLogVoiceLang', 'auto');
export const autoTranscribe    = createSettingStore('autoTranscribe',    true);
export const autoSummarizeLong = createSettingStore('autoSummarizeLong', false);
export const autoReadImages    = createSettingStore('autoReadImages',    false);
export const aiTranscribeModel = createSettingStore('aiTranscribeModel', '');

// Notifications
export const notifLocalEnabled = createSettingStore('notifLocalEnabled', true);
export const notifPushService  = createSettingStore('notifPushService',  'none');
export const appriseUrl  = createSettingStore('appriseUrl',  '');
export const appriseTag  = createSettingStore('appriseTag',  '');
export const gotifyUrl   = createSettingStore('gotifyUrl',   '');
export const gotifyToken = createSettingStore('gotifyToken', '');
export const ntfyUrl     = createSettingStore('ntfyUrl',     'https://ntfy.sh');
export const ntfyTopic   = createSettingStore('ntfyTopic',   '');
export const ntfyToken   = createSettingStore('ntfyToken',   '');

// Hours between automatic update checks. 0 = manual only (Settings →
// Updates → Check now is the only way). Also gates the visibility-change
// re-check trigger in App.svelte. Mirrors NT's #updates-cadence-settable.
export const updateCheckInterval = createSettingStore('updateCheckInterval', 4);

// Local-mode scheduled backup. Per-device localStorage (no server in
// local mode). Tick runs JS-side via local-backup-scheduler.js while the
// app is open. Mirrors NutriTrace's same-named keys for TraceApps parity.
export const localBackupSchedule  = createSettingStore('localBackupSchedule',  'off');
export const localBackupTime      = createSettingStore('localBackupTime',      '03:00');
export const localBackupRetention = createSettingStore('localBackupRetention', 7);
export const localBackupLastRun   = createSettingStore('localBackupLastRun',   null);
export const localBackupLastError = createSettingStore('localBackupLastError', null);

// ── Apply helpers ──────────────────────────────────────────────────────────
let _lastAppliedAccent = null;
export function applyAccentColor(value) {
  if (value === _lastAppliedAccent) {
    accentColor.set(value);
    return;
  }
  _lastAppliedAccent = value;
  const isHex = /^#[0-9a-fA-F]{6}$/.test(value);
  ['--accent','--accent-2','--accent-dim','--accent-text'].forEach(v =>
    document.documentElement.style.removeProperty(v));
  if (value === 'lavender') {
    document.documentElement.removeAttribute('data-accent');
  } else if (isHex) {
    document.documentElement.removeAttribute('data-accent');
    const r = parseInt(value.slice(1,3), 16);
    const g = parseInt(value.slice(3,5), 16);
    const b = parseInt(value.slice(5,7), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    document.documentElement.style.setProperty('--accent',      value);
    document.documentElement.style.setProperty('--accent-2',    value);
    document.documentElement.style.setProperty('--accent-dim',  `rgba(${r},${g},${b},0.15)`);
    document.documentElement.style.setProperty('--accent-text', lum > 0.55 ? '#0A0B0F' : '#FFFFFF');
  } else {
    document.documentElement.setAttribute('data-accent', value);
  }
  // Tint the browser-chrome tab bar to match the accent. Chromium
  // reads <meta name="theme-color"> and paints the address-bar strip
  // (and the top of the focused tab on Android) with it, so multi-
  // instance self-hosters can spot which install a tab belongs to at
  // a glance. Favicon stays the branded logo.
  _applyThemeColor(value);
  accentColor.set(value);
}

/** Resolve any accent value (named, hex, or fallback) to a hex string.
 *  Names match ACCENT_COLORS in Settings.svelte's picker; both files
 *  must stay in sync when accents are added. */
function _accentToHex(value) {
  if (typeof value !== 'string') return null;
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  const NAMED = {
    lavender: '#B69CFF',
    mint:   '#4FFFB0', blue:  '#4FC3F7', red:    '#FF7070',
    purple: '#CE93D8', orange:'#FFB547', teal:   '#4DD0E1',
    pink:   '#F48FB1', yellow:'#FFF176', indigo: '#9FA8DA',
    lime:   '#C5E1A5', rose:  '#FF80AB', cyan:   '#80DEEA',
  };
  return NAMED[value] || null;
}

function _applyThemeColor(accentValue) {
  const hex = _accentToHex(accentValue);
  if (!hex) return;
  const meta = document.getElementById('theme-color-meta');
  if (meta) meta.content = hex;
}

let _lastAppliedAppearance = null;
export function applyAppearance(value) {
  if (value === _lastAppliedAppearance) {
    appearance.set(value);
    return;
  }
  _lastAppliedAppearance = value;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = value === 'dark' || (value === 'system' && prefersDark);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  // Re-apply the accent-tinted browser-chrome color; falls back to the
  // bg-based color only when no accent is loaded yet (early boot).
  const accentHex = _accentToHex(_lastAppliedAccent);
  const meta = document.getElementById('theme-color-meta');
  if (meta) meta.content = accentHex || (dark ? '#0A0B0F' : '#F5F7FA');
  appearance.set(value);
}
