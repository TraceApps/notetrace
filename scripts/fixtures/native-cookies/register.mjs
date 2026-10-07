// Runs the app's own modules (lib/platform.js, lib/migrate.js,
// stores/auth.js, lib/sync.js) in Node as an Android phone in server mode:
// localStorage and the WebView's globals are stand-ins, and every
// @capacitor/* import comes from capacitor.mjs, which keeps Android's
// native cookie jar in a file (PHONE_JAR). Used by
// scripts/native-cookies.test.js.
import { register } from 'node:module';
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k), clear: () => store.clear(), key: i => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
const et = new EventTarget();
globalThis.window = globalThis;
globalThis.addEventListener = et.addEventListener.bind(et);
globalThis.removeEventListener = et.removeEventListener.bind(et);
globalThis.dispatchEvent = et.dispatchEvent.bind(et);
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class extends Event { constructor(t, o = {}) { super(t, o); this.detail = o.detail; } };
}
// The WebView's own address (capacitor.config.ts server.hostname).
globalThis.location = { origin: 'https://app.notetrace.local', href: 'https://app.notetrace.local/', pathname: '/', search: '', hash: '' };
globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', documentElement: { classList: { add() {}, remove() {}, toggle() {} } } };
register('./hooks.mjs', import.meta.url);
