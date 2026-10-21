import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { setMaxListeners } from 'node:events';
import { writable, get, derived } from 'svelte/store';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
// Run the real storage, policy, and settings store with isolated browser
// storage and deterministic timers. Svelte's stores are the real stores.
const source = [
  '../src/lib/setting-key.js', '../src/lib/db.js',
  '../src/lib/font-sync.js', '../src/stores/settings.js',
].map(read).join('\n')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export { DB };', '')
  .replace(/\bexport (?=(?:const|function|async function)\b)/g, '')
  .replaceAll('import.meta.env.DEV', 'false');

function browser(server = new Map(), local = {}, userId = '1') {
  const storage = new Map([['wl:userId', userId]]);
  for (const [key, value] of Object.entries(local)) storage.set(`wl_u${userId}_${key}`, JSON.stringify(value));
  const window = new EventTarget();
  setMaxListeners(0, window); // a real window supports one listener per setting store
  window.matchMedia = () => ({ matches: false });
  const timers = new Map(), requests = [];
  let timerId = 0;
  const env = {
    writable, get, derived, window, console, AbortSignal,
    CustomEvent: class extends Event { constructor(type, options) { super(type); this.detail = options.detail; } },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
      key: i => [...storage.keys()][i], get length() { return storage.size; },
    },
    isNative: false, getServerUrl: () => null, getAuthToken: () => null, apiUrl: path => path,
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, init = {}) => {
      const user = storage.get('wl:userId');
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : null;
      requests.push({ user, url, method, body });
      if (method === 'PUT') {
        const settings = server.get(user) || {};
        Object.assign(settings, body.settings || { [body.key]: body.value });
        server.set(user, settings);
      }
      const snapshot = structuredClone(server.get(user) || {});
      return { ok: true, json: async () => snapshot };
    },
  };
  const app = vm.runInNewContext(`${source}\n({ DB, fontTheme, fontSize, fontSyncScope, setFontSyncScope,
    loadServerSettings, bulkSet, reloadSettingStores, isLocalFontSetting });`, env);
  return {
    ...app, env, requests, server,
    async flush() {
      const pending = [...timers.values()]; timers.clear();
      for (const fn of pending) await fn();
    },
    writes: () => requests.filter(r => r.method === 'PUT'),
  };
}

test('account typography saves and restores in a fresh browser without uploading defaults', async () => {
  const first = browser();
  assert.equal(first.fontSyncScope.get(), 'account');
  first.fontTheme.set('pair-terminal'); first.fontSize.set(19);
  await first.flush();
  assert.equal(first.writes().length, 2);
  const incognito = browser(first.server);
  await incognito.loadServerSettings(); await incognito.flush();
  assert.equal(incognito.fontTheme.get(), 'pair-terminal');
  assert.equal(incognito.fontSize.get(), 19);
  assert.equal(incognito.writes().length, 0);
});

test('existing local typography migrates only where the account has no saved choice', async () => {
  const server = new Map([['1', { fontTheme: 'mono' }]]);
  const app = browser(server, { fontTheme: 'lora', fontSize: 18 });
  await app.loadServerSettings(); await app.flush();
  assert.equal(app.fontTheme.get(), 'mono');
  assert.deepEqual(server.get('1'), { fontTheme: 'mono', fontSize: 18 });
  assert.equal(app.writes().length, 1);
  await app.loadServerSettings(); await app.flush();
  assert.equal(app.writes().length, 1, 'idle refresh does not resend');
});

test('a fresh account with no explicit typography never uploads its defaults', async () => {
  const app = browser();
  await app.loadServerSettings(); await app.flush();
  assert.equal(app.writes().length, 0);
  assert.equal(app.fontTheme.get(), 'default');
  assert.equal(app.fontSize.get(), 15);
});

test('device-only mode survives reload and prevents pushes, pulls, and migration', async () => {
  const server = new Map([['1', { fontTheme: 'mono', fontSize: 17, fontSyncScope: 'account' }]]);
  const app = browser(server, { fontSyncScope: 'device', fontTheme: 'lora', fontSize: 20 });
  app.fontTheme.set('nunito'); app.fontSize.set(21);
  await app.loadServerSettings(); await app.flush();
  assert.equal(app.fontSyncScope.get(), 'device');
  assert.equal(app.fontTheme.get(), 'nunito');
  assert.equal(app.fontSize.get(), 21);
  assert.equal(app.writes().length, 0);
  assert.equal(server.get('1').fontTheme, 'mono');
  assert.equal(app.isLocalFontSetting('fontTheme'), true);
});

test('opting out cancels pending saves; opting back in shares the current selection', async () => {
  const app = browser();
  app.fontTheme.set('lora'); app.fontSize.set(18);
  app.setFontSyncScope('device'); await app.flush();
  assert.equal(app.writes().length, 0);
  app.fontTheme.set('mono'); app.fontSize.set(22);
  await app.flush(); assert.equal(app.writes().length, 0);
  app.setFontSyncScope('account'); await app.flush();
  assert.deepEqual(app.server.get('1'), { fontTheme: 'mono', fontSize: 22 });
  assert.ok(app.writes().every(r => r.body.key !== 'fontSyncScope'));
});

test('bulk updates respect the selected scope, while other account preferences sync', async () => {
  const app = browser();
  await app.bulkSet({ fontSyncScope: 'device', fontTheme: 'lora', fontSize: 20, language: 'et' });
  assert.deepEqual(app.server.get('1'), { language: 'et' });
  assert.equal(app.fontTheme.get(), 'lora');
  await app.bulkSet({ fontSyncScope: 'account', fontTheme: 'mono', fontSize: 16 });
  assert.deepEqual(app.server.get('1'), { language: 'et', fontTheme: 'mono', fontSize: 16 });
});

test('a settings refresh cannot revert a font awaiting its debounced save', async () => {
  const app = browser(new Map([['1', { fontTheme: 'mono', fontSize: 15 }]]));
  app.fontTheme.set('lora'); app.fontSize.set(19);
  await app.loadServerSettings();
  assert.equal(app.fontTheme.get(), 'lora'); assert.equal(app.fontSize.get(), 19);
  await app.flush();
  assert.deepEqual(app.server.get('1'), { fontTheme: 'lora', fontSize: 19 });
});

test('a late read or pending save from another account cannot affect the next account', async () => {
  const app = browser(undefined, { fontTheme: 'lora' });
  let finish;
  app.env.fetch = () => new Promise(resolve => { finish = resolve; });
  const loading = app.loadServerSettings();
  app.env.localStorage.setItem('wl:userId', '2');
  finish({ ok: true, json: async () => ({ fontTheme: 'mono', fontSize: 20 }) });
  await loading; await app.flush();
  assert.equal(app.DB.getSetting('fontTheme', null), null);
  app.reloadSettingStores({ force: true });
  assert.equal(app.fontTheme.get(), 'default');
  app.env.localStorage.setItem('wl:userId', '1');
  app.reloadSettingStores({ force: true });
  app.fontTheme.set('nunito');
  app.env.localStorage.setItem('wl:userId', '2');
  await app.flush();
  assert.equal(app.writes().length, 0);
});

test('native and offline retry paths use the same device-only typography policy', () => {
  const native = read('../src/lib/db-native.js');
  assert.match(native, /return \(r\?\.values \|\| \[\]\)\.filter\(row => !isLocalFontSetting\(row\.key\)\)/);
  assert.match(native, /if \(isLocalFontSetting\(s\.key\)\) continue;/);
  const offline = read('../src/lib/offline-api.js');
  assert.match(offline, /op\.path === '\/api\/settings' && isLocalFontSetting\(op\.body\?\.key\)/);
});
