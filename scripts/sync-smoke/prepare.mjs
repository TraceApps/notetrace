/**
 * Builds two simulated Android devices from the REAL client sync code
 * (src/lib/sync.js, db-native.js, notes-native.js) with the Capacitor
 * SQLite plugin swapped for better-sqlite3, so scenario.mjs can exercise
 * device-to-server-to-device sync without a phone.
 *
 * Run inside the NoteTrace image (it ships better-sqlite3), against a
 * THROWAWAY server with no accounts yet:
 *
 *   docker run -d --name nt-test -p 3004:3001 -e JWT_SECRET=... <image>
 *   docker run --rm --network host -v "$PWD":/repo -w /repo --entrypoint sh <image> \
 *     -c "node scripts/sync-smoke/prepare.mjs && node scripts/sync-smoke/scenario.mjs"
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const src = p => readFileSync(new URL(p, root), 'utf8');
const serverUrl = process.env.NOTETRACE_URL || 'http://localhost:3004';
const sqliteFrom = process.env.SQLITE_REQUIRE_FROM || '/app/package.json';

rmSync(new URL('.build/', import.meta.url), { recursive: true, force: true });
for (const dev of ['devA', 'devB']) {
  const dir = new URL(`.build/${dev}/`, import.meta.url);
  mkdirSync(dir, { recursive: true });
  const put = (name, text) => writeFileSync(new URL(name, dir), text);
  put('db-native.mjs', src('src/lib/db-native.js')
    .replace("from '@capacitor-community/sqlite'", "from './sqlite-stub.mjs'")
    .replaceAll("from './platform.js'", "from './platform.mjs'"));
  put('sync.mjs', src('src/lib/sync.js')
    .replace("from 'svelte/store'", "from './store-stub.mjs'")
    .replaceAll("from './platform.js'", "from './platform.mjs'")
    .replaceAll("from './db-native.js'", "from './db-native.mjs'")
    .replaceAll("import('./db-native.js')", "import('./db-native.mjs')")
    + '\nexport { pushChanges, pullChanges };\n');
  put('notes-native.mjs', src('src/lib/notes-native.js').replace("from './db-native.js'", "from './db-native.mjs'"));
  put('sqlite-stub.mjs', `import { createRequire } from 'node:module';
const Database = createRequire(${JSON.stringify(sqliteFrom)})('better-sqlite3');
export const CapacitorSQLite = {};
export class SQLiteConnection {
  async checkConnectionsConsistency() {}
  async closeConnection() {}
  async createConnection() {
    const raw = new Database(':memory:');
    return {
      async open() {},
      async execute(sql) { raw.exec(sql); return {}; },
      async query(sql, params = []) { return { values: raw.prepare(sql).all(...params) }; },
      async run(sql, params = []) { const i = raw.prepare(sql).run(...params); return { changes: { changes: i.changes, lastId: Number(i.lastInsertRowid) } }; },
    };
  }
}
`);
  put('platform.mjs', `export const isNative = true;
let token = '';
export const setToken = t => { token = t; };
export const getServerUrl = () => ${JSON.stringify(serverUrl)};
export const getAuthToken = () => token;
export const apiUrl = p => ${JSON.stringify(serverUrl)} + p;
export const getNativeMode = () => 'server';
`);
  put('store-stub.mjs', 'export function writable(v){const s=new Set();return{set(n){v=n;s.forEach(f=>f(v));},update(fn){v=fn(v);s.forEach(f=>f(v));},subscribe(f){s.add(f);f(v);return()=>s.delete(f);}};}\n');
  put('device.mjs', `export { NotesNative as N } from './notes-native.mjs';
export { pushChanges, pullChanges } from './sync.mjs';
export { setToken } from './platform.mjs';
export { dbInit } from './db-native.mjs';
`);
}
console.log('built simulated devices in scripts/sync-smoke/.build/');
