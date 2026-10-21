// Runs stores/auth.js in Node as the web app (AUTH_PHONE unset) or the
// Android app (AUTH_PHONE=1), starting with the localStorage in AUTH_STORE
// (JSON) and answering fetch from AUTH_REPLIES (JSON: path -> reply, "drop"
// for a connection that fails, or "redirect" for a redirect not followed).
// Used by scripts/auth-start.test.js.
import { register } from 'node:module';
const store = new Map(Object.entries(JSON.parse(process.env.AUTH_STORE || '{}')));
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
globalThis.location = { origin: 'https://notes.example.com', href: 'https://notes.example.com/', pathname: '/', search: '', hash: '' };
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', documentElement: { classList: { add() {}, remove() {}, toggle() {} } } };
const replies = JSON.parse(process.env.AUTH_REPLIES || '{}');
globalThis.fetch = async (url) => {
  const path = new URL(String(url), 'https://notes.example.com').pathname;
  const r = replies[path] ?? replies['*'] ?? 'drop';
  if (r === 'drop') throw new TypeError('Failed to fetch');
  // A redirect not followed (redirect: 'manual'), as a browser hands it back.
  if (r === 'redirect') return { type: 'opaqueredirect', ok: false, status: 0, headers: new Headers(), text: async () => '' };
  const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
  return new Response(r.status === 204 ? null : body, { status: r.status ?? 200, headers: r.type ? { 'Content-Type': r.type } : {} });
};
register('./hooks.mjs', import.meta.url);
