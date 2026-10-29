/**
 * Any page can open NoteTrace with share=1 and text filled in, or send the
 * installed app's share-target POST (a service worker can't tell that from
 * the system share sheet), and the editor saved what it was given at once:
 * any site could put a note, files included, in a signed-in person's account.
 * Now every web share opens as a draft that saves, and uploads its files, only
 * when the person keeps it or changes it; Android's share sheet saves as
 * before. A voice note opened from a link waits for a tap on Record, and no
 * web page can open the app's notetrace://new link. The server also says
 * which pages may frame NoteTrace (lib/frame-ancestors.js and its own test).
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const SCOPE = 'https://notes.example.com/';

// Cache Storage, in memory, as the browser keeps it for one site.
function cacheStorage() {
  const caches = new Map();
  return {
    async open(name) {
      if (!caches.has(name)) caches.set(name, new Map());
      const m = caches.get(name);
      return {
        async put(req, res) { m.set(typeof req === 'string' ? req : req.url, { b: await res.arrayBuffer(), h: [...res.headers] }); },
        async match(req) { const e = m.get(typeof req === 'string' ? req : req.url); return e ? new Response(e.b, { headers: e.h }) : undefined; },
        async keys() { return [...m.keys()].map((u) => new Request(u)); },
        async delete(req) { return m.delete(typeof req === 'string' ? req : req.url); },
      };
    },
  };
}

// The worker's share target, run as the browser would (public/sw-extras.js).
async function shareThroughWorker(fields, files = []) {
  const listeners = {};
  const self = { registration: { scope: SCOPE }, clients: { matchAll: async () => [], openWindow: async () => {} }, addEventListener: (type, fn) => { listeners[type] = fn; } };
  vm.runInNewContext(read('../public/sw-extras.js'), { self, caches: globalThis.caches, URL, URLSearchParams, Request, Response, Promise, Date, Math, Number, String, encodeURIComponent });
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  for (const f of files) form.append('images', f);
  let responded;
  listeners.fetch({ request: { method: 'POST', url: `${SCOPE}share-target`, formData: async () => form }, respondWith: (p) => { responded = p; } });
  return new URL((await responded).headers.get('location'));
}

test('a web share carries its text and files, and nothing that would make it save itself', async () => {
  globalThis.caches = cacheStorage();
  const { takeSharedFiles, clearOldShares } = await import('../src/lib/share-intent.js');
  const to = await shareThroughWorker({ title: 'Shared', text: 'hello' }, [new File(['x'], 'a.txt', { type: 'text/plain' })]);
  const params = new URLSearchParams(to.hash.replace(/^#\/\?/, ''));
  assert.deepEqual([params.get('share'), params.get('title'), params.get('t')], ['1', 'Shared', null]);
  const files = await takeSharedFiles(params.get('files'));
  assert.deepEqual(files.map((f) => f.name), ['a.txt']);
  assert.deepEqual(await takeSharedFiles(params.get('files')), [], 'read once, then gone from the browser');
  // A share never opened doesn't stay: the app (and the next share) clear it after 10 minutes.
  const stale = new URLSearchParams((await shareThroughWorker({ text: 'never opened' }, [new File(['y'], 'b.txt')])).hash.replace(/^#\/\?/, '')).get('files');
  await clearOldShares(Date.now() + 11 * 60 * 1000);
  assert.deepEqual(await takeSharedFiles(stale), []);
  delete globalThis.caches;
});

test('only the app\'s own new-note links start recording at once', async () => {
  const { markAppNewNote, takeAppNewNote } = await import('../src/lib/new-note-intent.js');
  assert.equal(takeAppNewNote('voice'), false, 'a link to the web app: nothing marked');
  markAppNewNote('voice');
  assert.equal(takeAppNewNote('voice'), true, 'the shortcut or widget');
  assert.equal(takeAppNewNote('voice'), false, 'once');
  markAppNewNote('text');
  assert.equal(takeAppNewNote('voice'), false, 'another kind');
  markAppNewNote('voice');
  assert.equal(takeAppNewNote('voice', Date.now() + 6000), false, 'only right after the deep link');
  // No web page can open notetrace://new: it isn't a browsable link any more;
  // the shortcuts and the widget open it with explicit intents.
  const manifest = read('../android/app/src/main/AndroidManifest.xml');
  const browsable = manifest.match(/<intent-filter[^>]*>(?:(?!<\/intent-filter>)[\s\S])*BROWSABLE(?:(?!<\/intent-filter>)[\s\S])*<\/intent-filter>/g) || [];
  assert.ok(browsable.length);
  for (const f of browsable) assert.doesNotMatch(f, /<data android:scheme="notetrace" android:host="new"/);
  // The shortcuts go through AppShortcutActivity (app-shortcut-activity.test.js).
  for (const m of read('../android/app/src/main/res/xml/shortcuts.xml').match(/<intent[\s\S]*?\/>/g)) assert.match(m, /android:targetClass="com\.notetrace\.app\.AppShortcutActivity"/);
  assert.match(read('../android/app/src/main/java/com/notetrace/app/NoteWidgetStore.java'), /i\.setClassName\(context, MainActivity\.class\.getName\(\)\);/);
});

test('the notes page and the editor treat every web share as a draft', () => {
  const notes = read('../src/routes/Notes.svelte');
  assert.match(notes, /prefill\.images = await takeSharedFiles\(params\.get\('files'\)\);\n\s*prefill\.fromLink = true;/);
  assert.match(notes, /if \(fresh === 'voice'\) newVoiceNote\(!takeAppNewNote\('voice'\)\);/);
  const editor = read('../src/components/notes/NoteEditor.svelte');
  assert.match(editor, /let linkDraft = !note && !!prefill\?\.fromLink;/);
  assert.match(editor, /if \(!linkDraft && prefill\?\.images\?\.length\) addFiles\(prefill\.images\);/, 'files wait in a draft');
  assert.match(editor, /<VoiceRecorder canAddFile=\{!contentLocked\} waitForTap=\{recordOnTap\}/);
  // Android's share sheet (pendingShare) never sets fromLink.
  assert.doesNotMatch(read('../src/lib/share-intent.js'), /pendingShare\.set\(\{[^}]*fromLink/);
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.equal(en.notes.link_draft_keep, 'Keep');
  assert.equal(en.voice.start, 'Record');
});

// ── The real server ─────────────────────────────────────────────────────
let ready = false;
try { const Db = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3'); new Db(':memory:').close(); ready = true; } catch { /* server packages missing or built for another Node: the server cases skip */ }
const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const servers = [];
test.after(() => { for (const s of servers) s.kill(); });
async function start(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'notetrace-share-'));
  mkdirSync(join(dir, 'u'), { recursive: true });
  writeFileSync(join(dir, 'u', 'a1b2c3d4e5.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const port = await freePort();
  const keep = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'NODE_OPTIONS'];
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]])), PORT: String(port), DB_PATH: join(dir, 'n.db'), UPLOADS_PATH: join(dir, 'u'), BACKUPS_PATH: join(dir, 'b'), JWT_SECRET: 'share-test-0123456789abcdef0123456789abcdef', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'warn', ...env },
    stdio: 'ignore',
  });
  servers.push(proc);
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/auth/status`)).ok) return `http://127.0.0.1:${port}`; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

test('the server tells browsers which pages may frame it, on every answer', { skip: !ready && 'server packages not installed' }, async () => {
  const base = await start();
  const badJson = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
  assert.equal(badJson.status, 400);
  for (const r of [await fetch(base + '/'), await fetch(base + '/api/auth/status'), await fetch(base + '/n/whatever'), badJson]) {
    assert.equal(r.headers.get('content-security-policy'), "frame-ancestors 'self'", r.url);
    assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN', r.url);
  }
  const up = await fetch(base + '/uploads/a1b2c3d4e5.png');
  assert.equal(up.status, 200);
  assert.match(up.headers.get('content-security-policy'), /; sandbox; frame-ancestors 'self'$/);
  assert.equal(up.headers.get('x-frame-options'), 'SAMEORIGIN');
  // A form POSTed from another site lands in the app as a share link and nothing more.
  const form = new FormData();
  form.set('title', 'planted'); form.set('text', 'from elsewhere');
  const post = await fetch(base + '/share-target', { method: 'POST', body: form, redirect: 'manual', headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(post.status, 303);
  assert.match(post.headers.get('location'), /\/#\/\?share=1&title=planted&text=from\+elsewhere$/);
  const dash = await start({ FRAME_ANCESTORS: 'https://dash.example.com/board' });
  const d = await fetch(dash + '/');
  assert.equal(d.headers.get('content-security-policy'), "frame-ancestors 'self' https://dash.example.com");
  assert.equal(d.headers.get('x-frame-options'), null);
  const dup = await fetch(dash + '/uploads/a1b2c3d4e5.png');
  assert.match(dup.headers.get('content-security-policy'), /; sandbox; frame-ancestors 'self' https:\/\/dash\.example\.com$/);
});

test('a shortcut marks its new note once, and nothing a link opens takes focus', () => {
  const app = readFileSync(new URL('../src/App.svelte', import.meta.url), 'utf8');
  // A cold start brings the launch URL and appUrlOpen: whichever comes first
  // marks and opens it, and the other is dropped (marking and opening both
  // started the recorder twice on the emulator).
  const launch = app.slice(app.indexOf('App.getLaunchUrl'), app.indexOf("addListener('appUrlOpen'"));
  const urlOpen = app.slice(app.indexOf("if (host === 'new')"), app.indexOf("if (host === 'oidc-callback')"));
  for (const path of [launch, urlOpen]) assert.match(path, /const route = newNoteRoute\([^)]+\);\s*if \(!route\) return;\s*markAppNewNote\(/);
  const vr = readFileSync(new URL('../src/components/notes/VoiceRecorder.svelte', import.meta.url), 'utf8');
  assert.doesNotMatch(vr, /vr-start"[^>]*autofocus/, 'the waiting Record button is not focused');
  const ed = readFileSync(new URL('../src/components/notes/NoteEditor.svelte', import.meta.url), 'utf8');
  assert.match(ed, /!voiceFirst && !linkDraft\) titleEl\?\.focus\(\)/, 'a link draft is not focused');
});
