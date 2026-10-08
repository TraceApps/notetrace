// One phone: the app's own modules, opened on PHONE_DB, signed in to the
// server in NOTE_SERVER the ways the app signs in. Used by
// scripts/android-sync.test.js through `open()`.
const SRC = new URL('../../../src/', import.meta.url).href;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The network as the phone sees it. Every request (the WebView's fetch and
// CapacitorHttp alike) goes through here: it can be offline, slow by a
// random amount (PHONE_DELAY_MS), lose one answer after the server has the
// request (`dropAnswer`), or stand in for an older server that reports no
// instance id (`noInstanceId`).
const realFetch = globalThis.fetch;
const net = { offline: false, dropAnswer: null, noInstanceId: false, sent: [] };
const delayMax = Number(process.env.PHONE_DELAY_MS || 0);
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (net.offline) throw new TypeError('Failed to fetch');
  if (delayMax) await sleep(Math.floor(Math.random() * delayMax));
  net.sent.push({ url: u.replace(/^https?:\/\/[^/]+/, ''), method: init?.method || 'GET' });
  const res = await realFetch(url, init);
  if (net.dropAnswer && net.dropAnswer(u, init)) { net.dropAnswer = null; await res.text(); throw new TypeError('Failed to fetch'); }
  if (net.noInstanceId && u.includes('/api/auth/status')) {
    const body = await res.json();
    delete body.instance_id;
    delete body.sync_version;
    return new Response(JSON.stringify(body), { status: res.status, headers: { 'Content-Type': 'application/json' } });
  }
  return res;
};

export async function open() {
  const S = process.env.NOTE_SERVER;
  const platform = await import(SRC + 'lib/platform.js');
  const dbn = await import(SRC + 'lib/db-native.js');
  await dbn.dbInit();
  const db = await dbn.getDb();
  const sync = await import(SRC + 'lib/sync.js');
  const auth = await import(SRC + 'stores/auth.js');
  const { NotesNative } = await import(SRC + 'lib/notes-native.js');
  const { get } = await import('svelte/store');
  // The account check the app runs before it shows anything (App.svelte).
  // Absent in versions of the app without it.
  let la = null;
  try { la = await import(SRC + 'lib/local-account.js'); } catch { /* none */ }
  const asked = [];
  let answer = true, sameServer = true;
  const tokens = JSON.parse(process.env.PHONE_TOKENS || '{}');

  const me = async () => {
    const r = await fetch(platform.apiUrl('/api/auth/me'), { headers: { Authorization: `Bearer ${platform.getAuthToken()}` } });
    return (await r.json()).user;
  };
  // What the app does once it knows who signed in (stores/auth.js), then
  // App.svelte's account check. False when the check signed them back out.
  async function signedIn() {
    const user = await me();
    localStorage.setItem('wl:userId', String(user.id));
    localStorage.setItem('note:cachedUser', JSON.stringify(user));
    auth.currentUser.set(user);
    if (!la) return true;
    return la.ensureLocalAccount(user, {
      confirm: async n => { asked.push({ kind: 'waiting', n }); return answer; },
      sameServer: async () => { asked.push({ kind: 'same_server' }); return sameServer; },
      signOut: () => auth.logout(),
    });
  }

  const p = {
    SRC, S, db, dbn, syncMod: sync, auth, platform, NotesNative, la, net, asked, sleep, get,
    answerWaiting(v) { answer = v; },
    answerSameServer(v) { sameServer = v; },
    // First-run setup (NativeSetup.svelte) and the sign-in screen
    // (Login.svelte) end the same way: the session token is kept, the
    // server's cookies are forgotten, and the app learns who it is. The
    // token comes from the test (PHONE_TOKENS: { server: { user: token } }),
    // made the way the server makes one, as sign-in is rate limited.
    async setupSignIn(username, server = S) {
      platform.setServerUrl(server);
      platform.setAuthToken(tokens[server][username]);
      await platform.forgetServerCookies?.(server);
      platform.setNativeMode('server');
      return signedIn();
    },
    async loginSignIn(username) {
      platform.setAuthToken(tokens[platform.getServerUrl()]?.[username] ?? tokens[S][username]);
      await platform.forgetServerCookies?.();
      return signedIn();
    },
    async logout() { await auth.logout(); },
    async sync() { return sync.fullSync({ silent: true }, true); },
    // What the notes screen lists (titles, sorted), and every note row here.
    async shown() {
      const own = await NotesNative.getNotes({ view: 'notes' });
      return own.map(n => n.title).sort();
    },
    async rows(table = 'notes') { return (await db.query(`SELECT * FROM ${table}`, [])).values; },
    async offline(fn) { net.offline = true; try { return await fn(); } finally { net.offline = false; } },
    done(x) { console.log('RESULT ' + JSON.stringify(x ?? null)); process.exit(0); },
  };
  return p;
}
