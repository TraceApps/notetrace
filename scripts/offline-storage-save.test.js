/**
 * Saving with a connection must not depend on this browser's own storage
 * (TraceApps/nutritrace#269). Loads the real offline layer against a small
 * stand-in for IndexedDB, so the cases a browser rarely shows on demand can
 * be staged: storage that refuses to open, a change waiting that the server
 * keeps failing on, and a store that breaks after the page loaded.
 */
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Scheduled flushes only run when a test asks for them.
mock.timers.enable({ apis: ['setTimeout'] });
// No other tab to talk to, and nothing left listening when the tests end.
globalThis.BroadcastChannel = undefined;
Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true });

const setOnline = (on) => Object.defineProperty(globalThis, 'navigator', { value: { onLine: on }, configurable: true, writable: true });
setOnline(true);

class FakeRequest {
  constructor() { this.result = undefined; this.error = null; this.onsuccess = null; this.onerror = null; }
}
globalThis.IDBRequest = FakeRequest;

const later = (fn) => queueMicrotask(fn);
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

/** Just enough IndexedDB for lib/offline-api.js, with switches to break it. */
function fakeIndexedDB() {
  const env = { dbs: new Map(), openThrows: false, broken: false, full: false };
  class Tx {
    constructor(db) {
      this.db = db; this.pending = 0; this.failed = null; this.finished = false;
      this.oncomplete = this.onerror = this.onabort = null;
      later(() => this.check());
    }
    objectStore(name) {
      const def = this.db.stores.get(name);
      if (!def) throw new DOMException(`No store ${name}`, 'NotFoundError');
      return new Store(def, this);
    }
    done() { this.pending--; this.check(); }
    check() {
      if (this.pending > 0 || this.finished) return;
      this.finished = true;
      later(() => {
        if (this.failed) { this.error = this.failed; this.onerror?.(); this.onabort?.(); } else this.oncomplete?.();
      });
    }
  }
  class Store {
    constructor(def, tx) { this.def = def; this.tx = tx; }
    req(fn, write) {
      const req = new FakeRequest();
      this.tx.pending++;
      later(() => {
        try {
          if (write && env.full) throw new DOMException('Quota exceeded', 'QuotaExceededError');
          req.result = fn();
          req.onsuccess?.({ target: req });
        } catch (e) {
          req.error = e; this.tx.failed = e; req.onerror?.({ target: req });
        }
        this.tx.done();
      });
      return req;
    }
    getAll() { return this.req(() => [...this.def.rows.values()].map(clone)); }
    get(key) { return this.req(() => clone(this.def.rows.get(key))); }
    add(value) {
      return this.req(() => {
        let key = this.def.keyPath ? value[this.def.keyPath] : undefined;
        if (key == null && this.def.autoIncrement) { key = ++this.def.seq; value = { ...value, [this.def.keyPath]: key }; }
        if (this.def.rows.has(key)) throw new DOMException('Key exists', 'ConstraintError');
        this.def.rows.set(key, clone(value));
        return key;
      }, true);
    }
    put(value, outOfLine) {
      return this.req(() => {
        const key = outOfLine ?? value[this.def.keyPath];
        this.def.rows.set(key, clone(value));
        return key;
      }, true);
    }
    delete(key) { return this.req(() => { this.def.rows.delete(key); }, true); }
    clear() { return this.req(() => { this.def.rows.clear(); }, true); }
  }
  class DB {
    constructor(name) { this.name = name; this.version = 0; this.stores = new Map(); }
    get objectStoreNames() { return { contains: (n) => this.stores.has(n) }; }
    createObjectStore(name, opts = {}) {
      this.stores.set(name, { keyPath: opts.keyPath, autoIncrement: !!opts.autoIncrement, rows: new Map(), seq: 0 });
    }
    transaction() {
      // What a dropped connection does: every new transaction throws.
      if (env.broken) throw new DOMException('The database connection is closing.', 'InvalidStateError');
      return new Tx(this);
    }
    close() {}
  }
  const idb = {
    open(name, version) {
      // What a browser refusing this site storage does.
      if (env.openThrows) throw new DOMException('The operation is insecure.', 'SecurityError');
      const req = new FakeRequest();
      later(() => {
        let db = env.dbs.get(name);
        if (!db) { db = new DB(name); env.dbs.set(name, db); }
        req.result = db;
        if (version && version > db.version) { db.version = version; req.onupgradeneeded?.(); }
        req.onsuccess?.();
      });
      return req;
    },
    deleteDatabase(name) { env.dbs.delete(name); },
  };
  /** A change already waiting when the page opens. */
  env.seed = (op) => {
    const name = 'notetrace-offline-single';
    let db = env.dbs.get(name);
    if (!db) { db = new DB(name); env.dbs.set(name, db); db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true }); }
    const out = db.stores.get('outbox');
    const seq = ++out.seq;
    out.rows.set(seq, { ...op, seq });
  };
  env.outbox = () => [...(env.dbs.get('notetrace-offline-single')?.stores.get('outbox')?.rows.values() || [])];
  return { idb, env };
}

/** The HTTP API, recording what reached the server. */
function fakeHttp() {
  const sent = [];
  const ok = (name, answer) => async (...args) => { sent.push([name, ...args]); if (http.fail) throw http.fail; return answer(...args); };
  const http = {
    sent,
    updateProfile: ok('updateProfile', (d) => ({ user: { id: 1, username: 'alex', role: 'admin', ...d } })),
    createNote: ok('createNote', (d) => ({ id: 41, title: '', body: '', ...d })),
    addAttachments: ok('addAttachments', (id, a) => ({ id, attachments: a })),
    getNotes: ok('getNotes', () => []),
    put: ok('put', (path, body) => ({ ok: true, ...body })),
    post: ok('post', (path, body) => ({ ok: true, ...body })),
  };
  return http;
}

let loads = 0;
/** A fresh copy of the offline layer, as a newly opened page has. */
async function page({ seed = [], openThrows = false } = {}) {
  const { idb, env } = fakeIndexedDB();
  env.openThrows = openThrows;
  for (const op of seed) env.seed(op);
  globalThis.indexedDB = idb;
  const mod = await import(`../src/lib/offline-api.js?page=${++loads}`);
  const http = fakeHttp();
  const api = mod.createOfflineApi(http);
  return { mod, api, http, env };
}

// A setting the server keeps failing on, still waiting.
const WAITING = { type: 'request', kind: 'the "units" setting', key: 'setting:units', method: 'PUT', path: '/api/settings', body: { key: 'units', value: 'metric' }, at: 1 };
const PROFILE = { full_name: 'Alex Doe', nickname: 'Lex', birthday: '1990-04-02', gender: 'female', avatar_url: '', email: '' };
const names = (http) => http.sent.map(s => s[0]);

test('storage that refuses to open: a profile save and the notes list still reach the server', async () => {
  setOnline(true);
  const { api, http } = await page({ openThrows: true });
  assert.equal((await api.updateProfile(PROFILE)).user.nickname, 'Lex');
  await api.getNotes();
  assert.deepEqual(names(http), ['updateProfile', 'getNotes']);
});

test('a change still waiting does not hold up a profile save', async () => {
  setOnline(true);
  const { mod, api, http, env } = await page({ seed: [WAITING] });
  assert.equal(await mod.pendingCount(), 1);
  const answer = await api.updateProfile(PROFILE);
  assert.ok(!answer.queued);
  assert.equal(answer.user.role, 'admin');
  assert.deepEqual(names(http), ['updateProfile']);
  assert.deepEqual(env.outbox().map(o => o.key), ['setting:units'], 'what was waiting is still kept');
});

test('a change waiting and the store breaking: saves still reach the server', async () => {
  const saves = {
    updateProfile: (api) => api.updateProfile(PROFILE),
    createNote: (api) => api.createNote({ title: 'Shopping' }),
    addAttachments: (api) => api.addAttachments(41, [{ url: '/uploads/a.jpg' }]),
  };
  for (const [name, save] of Object.entries(saves)) {
    setOnline(true);
    const { mod, api, http, env } = await page({ seed: [WAITING] });
    assert.equal(await mod.pendingCount(), 1);
    env.broken = true;
    await save(api);
    assert.deepEqual(names(http), [name]);
    assert.equal(await mod.pendingCount(), 1, 'what was waiting is still counted');
  }
});

test('the queue keeps its order when it can still be read', async () => {
  setOnline(true);
  const { mod, api, http } = await page({ seed: [WAITING] });
  assert.equal(await mod.pendingCount(), 1);
  await api.createNote({ title: 'Shopping' });
  assert.equal(http.sent.length, 0, 'nothing sent ahead of what was waiting');
  assert.equal(await mod.pendingCount(), 2);
});

test('an earlier profile save still waiting goes, and the new one takes its place', async () => {
  setOnline(true);
  const older = { type: 'request', kind: 'your profile', key: 'profile', method: 'PUT', path: '/api/auth/profile', body: { ...PROFILE, nickname: 'Old' }, at: 1 };
  const { mod, api, http, env } = await page({ seed: [older, WAITING] });
  assert.equal(await mod.pendingCount(), 2);
  await api.updateProfile(PROFILE);
  assert.deepEqual(http.sent.map(s => [s[0], s[1].nickname]), [['updateProfile', 'Lex']]);
  assert.deepEqual(env.outbox().map(o => o.key), ['setting:units']);
});

test('with no Web Locks (plain http), a flush asked for during the save waits for it', async () => {
  setOnline(true);
  const older = { type: 'request', kind: 'your profile', key: 'profile', method: 'PUT', path: '/api/auth/profile', body: { ...PROFILE, nickname: 'Old' }, at: 1 };
  const { mod, api, http, env } = await page({ seed: [older] });
  assert.equal(await mod.pendingCount(), 1);
  let land;
  http.updateProfile = (d) => { http.sent.push(['updateProfile', d]); return new Promise(r => { land = () => r({ user: { id: 1, ...d } }); }); };
  const saving = api.updateProfile(PROFILE);
  for (let i = 0; i < 200 && !land; i++) await new Promise(r => setImmediate(r));
  assert.ok(land, 'the new save went to the server');
  const flushing = mod.flushOutbox();
  land();
  await saving;
  await flushing;
  assert.deepEqual(http.sent.map(s => [s[0], s[1]?.nickname ?? s[2]?.nickname]), [['updateProfile', 'Lex']], 'the older save is never sent');
  assert.deepEqual(env.outbox(), []);
});

test('no connection and nowhere to keep it: the error says storage, not offline', async () => {
  for (const breakIt of [(env) => { env.full = true; }, (env) => { env.broken = true; }]) {
    setOnline(false);
    const { mod, api, http, env } = await page();
    await mod.pendingCount();
    breakIt(env);
    await assert.rejects(api.updateProfile(PROFILE), (err) => err.storage === true && !err.offline);
    await assert.rejects(api.createNote({ title: 'Shopping' }), (err) => err.storage === true && !err.offline);
    assert.equal(http.sent.length, 0);
  }
  setOnline(true);
});

test('a save tried directly is never sent a second time when it can\'t be kept either', async () => {
  setOnline(true);
  const { mod, api, http, env } = await page();
  await mod.pendingCount();
  env.broken = true;
  http.fail = new TypeError('Failed to fetch');
  await assert.rejects(api.createNote({ title: 'Shopping' }), (err) => err.storage === true);
  assert.equal(http.sent.length, 1);
});

test('Android with a server sends the profile through the HTTP API, and Profile says why a save failed', async () => {
  const { readFileSync } = await import('node:fs');
  const api = readFileSync(new URL('../src/lib/api.js', import.meta.url), 'utf8');
  const serverOnly = api.match(/const SERVER_ONLY_METHODS = new Set\(\[([\s\S]*?)\]\);/)[1];
  assert.match(serverOnly, /'updateProfile'/);
  const cached = readFileSync(new URL('../src/lib/api-cached.js', import.meta.url), 'utf8');
  assert.ok(/updateProfile/.test(cached) || /'updateProfile'/.test(serverOnly));
  const profile = readFileSync(new URL('../src/routes/Profile.svelte', import.meta.url), 'utf8');
  assert.match(profile, /if \(data\?\.user\) currentUser\.set\(\{ \.\.\.get\(currentUser\), \.\.\.data\.user \}\);/);
  assert.match(profile, /showError\(e\?\.storage \? e\.message/);
  const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
  assert.ok(en.offline.not_kept && en.profile.errors.needs_connection);
});
