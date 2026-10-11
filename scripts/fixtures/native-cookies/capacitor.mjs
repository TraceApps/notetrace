// Android's native cookie jar. Capacitor makes it the process's
// CookieHandler (CapacitorCookies.load), so every native request
// (CapacitorHttp, and any HttpURLConnection) stores what a response sets
// and sends it to that host again, next to whatever Authorization header
// the request has. A cookie belongs to a host, whatever the port. A Secure
// cookie is never stored from plain http. Capacitor also keeps a copy at
// the app's own address (CapacitorCookieManager.put). Kept in a file
// (PHONE_JAR), as the phone keeps it on disk. The WebView's fetch (global
// fetch here) doesn't send this cross-site cookie.
import { readFileSync, writeFileSync } from 'node:fs';
const jarFile = () => process.env.PHONE_JAR || null;
const hostOf = u => { try { return new URL(u).hostname; } catch { return ''; } };
function readJar() { try { return JSON.parse(readFileSync(jarFile(), 'utf8')); } catch { return {}; } }
function writeJar(j) { if (jarFile()) writeFileSync(jarFile(), JSON.stringify(j)); }
async function http(method, o) {
  const host = hostOf(o.url);
  const headers = { ...(o.headers || {}) };
  const kept = readJar()[host];
  if (kept && Object.keys(kept).length) headers.Cookie = Object.entries(kept).map(([k, v]) => `${k}=${v}`).join('; ');
  const body = o.data == null || method === 'GET' ? undefined : (typeof o.data === 'string' ? o.data : JSON.stringify(o.data));
  const r = await fetch(o.url, { method, headers, body });
  const jar = readJar();
  for (const c of r.headers.getSetCookie?.() || []) {
    const [pair, ...attrs] = c.split(';').map(x => x.trim());
    const i = pair.indexOf('=');
    const name = pair.slice(0, i), value = pair.slice(i + 1);
    const gone = !value || attrs.some(a => /^expires=thu, 01 jan 1970/i.test(a) || /^max-age=0$/i.test(a));
    const at = [hostOf(globalThis.location?.origin)];
    if (!(attrs.some(a => /^secure$/i.test(a)) && o.url.startsWith('http:'))) at.push(host);
    for (const h of at) {
      jar[h] = jar[h] || {};
      if (gone) delete jar[h][name]; else jar[h][name] = value;
    }
  }
  writeJar(jar);
  const t = await r.text();
  let data = t;
  try { data = JSON.parse(t); } catch { /* text */ }
  return { status: r.status, data, headers: Object.fromEntries(r.headers) };
}
export const CapacitorHttp = {
  get: o => http('GET', o), post: o => http('POST', o), put: o => http('PUT', o),
  delete: o => http('DELETE', o), request: o => http(o.method || 'GET', o),
};
export const CapacitorCookies = {
  clearAllCookies: async () => { writeJar({}); },
  clearCookies: async ({ url }) => { const j = readJar(); delete j[hostOf(url)]; writeJar(j); },
  getCookies: async ({ url } = {}) => readJar()[hostOf(url)] || {},
  setCookie: async ({ url, key, value }) => { const j = readJar(); const h = hostOf(url); j[h] = { ...(j[h] || {}), [key]: value }; writeJar(j); },
  deleteCookie: async ({ url, key }) => { const j = readJar(); delete j[hostOf(url)]?.[key]; writeJar(j); },
  // Every host's cookies (a test's view of the whole jar).
  _all: async () => readJar(),
};
export const Capacitor = { isNativePlatform: () => true, convertFileSrc: x => x, getPlatform: () => 'android' };
// Plugins the modules load but these runs don't use.
const inert = new Proxy({}, { get: (_, k) => (k === 'then' ? undefined : async () => ({})) });
export const registerPlugin = () => inert;
export const Preferences = inert, App = { addListener() {} }, Network = { getStatus: async () => ({ connected: true }) };
export const BiometricAuth = inert, Browser = inert, Filesystem = inert, Directory = { Data: 'DATA', Cache: 'CACHE' };
export const CapacitorSQLite = inert;
export class SQLiteConnection { async checkConnectionsConsistency() { return { result: false }; } async isConnection() { return { result: false }; } async createConnection() { throw new Error('no SQLite in this stand-in'); } }
export default {};
