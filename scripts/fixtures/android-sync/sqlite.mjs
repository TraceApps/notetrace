// @capacitor-community/sqlite on better-sqlite3 (the server's driver), one
// file per connection name beside PHONE_DB, so a later run is the same
// phone. Scripts run the way the Android plugin runs them.
import { createRequire } from 'node:module';
const Database = createRequire(new URL('../../../server/package.json', import.meta.url))('better-sqlite3');
const dbs = new Map();
// A trip across the native bridge: a turn, or PHONE_BRIDGE_MS of real time.
const bridgeMs = Number(process.env.PHONE_BRIDGE_MS || 0);
const trip = () => new Promise(r => (bridgeMs ? setTimeout(r, bridgeMs) : setImmediate(r)));
const norm = p => (p || []).map(v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

// The first whole statement of `sql`, as SQLite's compiler takes it (the
// rest is ignored, as execSQL does). A trigger's body has ";" inside it,
// so a cut there is still incomplete.
function firstStatement(db, sql) {
  let at = sql.indexOf(';');
  while (at > -1) {
    const head = sql.slice(0, at + 1);
    try { db.prepare(head); return head; } catch (e) {
      if (!/incomplete input/i.test(e.message)) return head;
    }
    at = sql.indexOf(';', at + 1);
  }
  return sql;
}

function conn(name) {
  if (!dbs.has(name)) dbs.set(name, new Database(process.env.PHONE_DB ? `${process.env.PHONE_DB}-${name}.db` : ':memory:'));
  const db = dbs.get(name);
  return {
    async open() {}, async close() {},
    // As the Android plugin runs a script (UtilsSQLite.getStatementsArray
    // and Database.execute): split on ";\n" only, a piece that is just
    // "END" joined to the one before (a trigger's body), lines joined with
    // "--" comments dropped, and each piece handed to execSQL, which runs
    // only its first statement. Two statements on one line: the second
    // silently never runs.
    async execute(sql) {
      await trip();
      const before = db.prepare('SELECT total_changes() AS n').get().n;
      let pieces = String(sql).replace(/end;/g, 'END;').split(';\n').map(x => x.trim());
      for (let i = pieces.indexOf('END'); i > 0; i = pieces.indexOf('END')) pieces.splice(i - 1, 2, pieces[i - 1] + '; END');
      pieces = pieces.map(x => x.split('\n').map(l => { const k = l.indexOf('--'); return (k > -1 ? l.slice(0, k) : l).trim(); }).filter(Boolean).join(' '));
      for (const piece of pieces) {
        if (!piece) continue;
        const st = db.prepare(firstStatement(db, piece.endsWith(';') ? piece : piece + ';'));
        if (st.reader) st.all(); else st.run();
      }
      return { changes: { changes: db.prepare('SELECT total_changes() AS n').get().n - before } };
    },
    async query(sql, params) {
      await trip();
      const st = db.prepare(sql);
      if (!st.reader) { st.run(...norm(params)); return { values: [] }; }
      return { values: st.all(...norm(params)) };
    },
    // Each call waits a turn, as a trip across the native bridge does, so
    // other work (a sign-in, another sync) can run while one is writing.
    // run() also takes only the first statement, as the plugin does.
    async run(sql, params) {
      await trip();
      const r = db.prepare(firstStatement(db, String(sql).trim().endsWith(';') ? String(sql) : String(sql) + ';')).run(...norm(params));
      return { changes: { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) } };
    },
  };
}

export const CapacitorSQLite = {};
export class SQLiteConnection {
  async checkConnectionsConsistency() { return { result: false }; }
  async isConnection() { return { result: false }; }
  async closeConnection() {}
  async closeAllConnections() {}
  async retrieveConnection(n) { return conn(n); }
  async createConnection(n) { return conn(n); }
}
