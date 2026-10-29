/**
 * Closing the note editor sends links_only (the [[links]] follow a rename;
 * the title isn't an edit). It never waits on a server that has gone quiet
 * or while changes are still waiting to go: the editor closes at once, as
 * it did when the close queued the title. Loads the real offline layer
 * against a small stand-in for IndexedDB (as offline-storage-save.test.js).
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

const settle = async (p, n = 200) => { let done = false; p.then(() => { done = true; }, () => { done = true; }); for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); return done; };

test('closing the editor never waits on a quiet server, or behind waiting changes', async () => {
  setOnline(true);
  const { api, http, mod } = await page();
  const rd = await import('../src/lib/request-deadline.js');
  http.updateNote = (...a) => { http.sent.push(['updateNote', ...a]); return new Promise(() => {}); }; // a silent server
  rd.noteQuiet();
  assert.equal(await settle(api.updateNote(5, { title: 'B', rename_links_from: 'A', links_only: true })), true, 'closed at once');
  assert.deepEqual(names(http), [], 'nothing sent to the quiet server');
  // Changes still waiting: the close doesn't go ahead of them.
  const w = await page({ seed: [WAITING] });
  w.http.updateNote = (...a) => { w.http.sent.push(['updateNote', ...a]); return new Promise(() => {}); };
  assert.equal(await settle(w.api.updateNote(5, { title: 'B', rename_links_from: 'A', links_only: true })), true);
  assert.equal(names(w.http).filter(x => x === 'updateNote').length, 0);
  // No connection: the same.
  setOnline(false);
  const off = await page();
  off.http.updateNote = (...a) => { off.http.sent.push(['updateNote', ...a]); return new Promise(() => {}); };
  assert.equal(await settle(off.api.updateNote(5, { title: 'B', rename_links_from: 'A', links_only: true })), true);
  assert.deepEqual(names(off.http), []);
  setOnline(true);
});
