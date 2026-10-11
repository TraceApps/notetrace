// Runs the Android app's own modules (lib/db-native.js, notes-native.js,
// sync.js, platform.js, stores/auth.js, lib/local-account.js) in Node as
// one phone in server mode, against a real server: SQLite is
// better-sqlite3 behind a stand-in that runs scripts the way the Android
// plugin does (sqlite.mjs), and localStorage, the cookie jar and the
// install marker are files beside the phone's database (PHONE_DB), so a
// later run is the same phone after an app restart. Used by
// scripts/android-sync.test.js.
import { register } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
const lsFile = process.env.PHONE_DB ? process.env.PHONE_DB + '.localStorage.json' : null;
let store = new Map();
try { if (lsFile) store = new Map(Object.entries(JSON.parse(readFileSync(lsFile, 'utf8')))); } catch { /* a new phone */ }
const save = () => { if (lsFile) writeFileSync(lsFile, JSON.stringify(Object.fromEntries(store))); };
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); save(); },
  removeItem: k => { store.delete(k); save(); },
  clear: () => { store.clear(); save(); },
  key: i => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
const et = new EventTarget();
et.setMaxListeners?.(1000);
globalThis.window = globalThis;
globalThis.addEventListener = et.addEventListener.bind(et);
globalThis.removeEventListener = et.removeEventListener.bind(et);
globalThis.dispatchEvent = et.dispatchEvent.bind(et);
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class extends Event { constructor(t, o = {}) { super(t, o); this.detail = o.detail; } };
}
// The WebView's own address (capacitor.config.ts server.hostname).
globalThis.location = { origin: 'https://app.notetrace.local', href: 'https://app.notetrace.local/', pathname: '/', search: '', hash: '' };
globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', hidden: false, documentElement: { classList: { add() {}, remove() {}, toggle() {} } } };
register('./hooks.mjs', import.meta.url);
