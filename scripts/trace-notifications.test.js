import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createTraceNotifier, shouldNotifyTrace } from '../src/lib/trace-notification-core.js';

const event = (noteId = 7) => ({ noteId, key: `account:${noteId}`, title: 'Trip', failure: '', isCurrent: () => true });
test('watching the result stays quiet, but leaving the note, tab, or app notifies', () => {
  assert.equal(shouldNotifyTrace({ viewing: true, visibility: 'visible', focused: true }), false);
  assert.equal(shouldNotifyTrace({ viewing: false, visibility: 'visible', focused: true }), true);
  assert.equal(shouldNotifyTrace({ viewing: true, visibility: 'hidden', focused: false }), true);
  assert.equal(shouldNotifyTrace({ viewing: true, visibility: 'visible', focused: false }), true);
});
function fixture({ native = false, permission = 'granted', serviceWorker = true, silent } = {}) {
  const posted = [], opened = [], fallbacks = [], removed = [], pages = [];
  let action;
  let enabled = true, account = 'account';
  const registration = {
    showNotification: async (title, options) => { posted.push({ title, ...options }); },
    getNotifications: async () => [],
  };
  const plugin = {
    addListener: async (type, listener) => { action = listener; return { remove() {} }; },
    checkPermissions: async () => ({ display: permission }),
    createChannel: async () => {},
    schedule: async ({ notifications }) => { posted.push(...notifications); },
    removeDeliveredNotifications: async ({ notifications }) => { removed.push(...notifications); },
  };
  const web = {
    permission: () => permission,
    registration: async () => serviceWorker ? registration : null,
    clientId: async () => 'originating-tab',
    focus() {},
    create: (title, options) => {
      const notification = { title, ...options, closed: false, close() { this.closed = true; } };
      pages.push(notification); return notification;
    },
  };
  const notifier = createTraceNotifier({
    native, plugin, web, owner: 'this-app', enabled: () => enabled,
    isCurrent: data => data.owner === 'this-app' && data.key === `${account}:${data.kind === 'trace-chat' ? 'chat' : data.noteId}`,
    copy: value => ({ title: value.failure ? 'Needs attention' : 'Ready', body: 'Tap to review Trip', channel: 'Ask Trace', silent }),
    open: (id, data) => opened.push(data.kind === 'trace-chat' ? 'chat' : id), fallback: (text, review) => fallbacks.push({ text, review }),
  });
  return { notifier, posted, opened, fallbacks, removed, pages, registration, plugin, web,
    tap: data => action({ notification: { extra: data } }),
    disable: () => { enabled = false; }, switchAccount: () => { account = 'other'; } };
}

test('web delivery carries the originating tab and note, without generated content', async () => {
  const f = fixture();
  assert.equal(await f.notifier.show(event()), true);
  assert.equal(f.posted.length, 1);
  assert.deepEqual(f.posted[0].data, { kind: 'trace-result', noteId: 7, key: 'account:7', owner: 'this-app', clientId: 'originating-tab' });
  f.notifier.activate(f.posted[0].data);
  assert.deepEqual(f.opened, [7]);
  assert.equal(f.fallbacks.length, 0);
});

test('chat replies deliver through web, Android, and fallback and open chat without a note id', async () => {
  for (const options of [{}, { native: true }, { permission: 'denied' }]) {
    const f = fixture(options);
    const chat = { kind: 'trace-chat', key: 'account:chat', title: 'Trace', isCurrent: () => true };
    await f.notifier.show(chat);
    if (f.fallbacks.length) f.fallbacks[0].review();
    else if (options.native) f.tap(f.posted[0].extra);
    else f.notifier.activate(f.posted[0].data);
    assert.deepEqual(f.opened, ['chat']);
    f.switchAccount(); await f.notifier.show(chat);
    assert.equal(f.posted.length + f.fallbacks.length, 1);
  }
});

test('Android posts separate notifications per note, reuses an id on retry, and routes taps', async () => {
  const f = fixture({ native: true });
  await f.notifier.show(event(7)); await f.notifier.show(event(8)); await f.notifier.show(event(7));
  assert.notEqual(f.posted[0].id, f.posted[1].id);
  assert.equal(f.posted[0].id, f.posted[2].id);
  assert.equal(f.posted[0].channelId, 'notetrace-trace');
  f.tap(f.posted[1].extra);
  assert.deepEqual(f.opened, [8]);
  f.tap({ ...f.posted[0].extra, kind: 'update' });
  assert.deepEqual(f.opened, [8]);
  await f.notifier.clear();
  assert.equal(f.removed.length, 2);
});

test('denied or unsupported permission falls back to an in-app Review action', async () => {
  for (const native of [true, false]) {
    const f = fixture({ native, permission: 'denied' });
    assert.equal(await f.notifier.show(event()), false);
    assert.equal(f.posted.length, 0);
    f.fallbacks[0].review();
    assert.deepEqual(f.opened, [7]);
  }
});

test('service-worker delivery errors fall back to a clickable page notification', async () => {
  const f = fixture();
  f.registration.showNotification = async () => { throw new Error('SW unavailable'); };
  assert.equal(await f.notifier.show(event()), true);
  f.pages[0].onclick();
  assert.deepEqual(f.opened, [7]);
  assert.equal(f.pages[0].closed, true);
});

test('OS failures use Review and do not escape into the generation', async () => {
  const f = fixture({ native: true });
  f.plugin.schedule = async () => { throw new Error('OS unavailable'); };
  await f.notifier.show({ ...event(), failure: 'failed' });
  assert.equal(f.fallbacks[0].text.title, 'Needs attention');
});

test('disabled notifications and stale generations are silent', async () => {
  const f = fixture();
  f.disable(); await f.notifier.show(event());
  const g = fixture();
  await g.notifier.show({ ...event(), isCurrent: () => false });
  assert.equal(f.posted.length + f.fallbacks.length + g.posted.length + g.fallbacks.length, 0);
});

test('account changes suppress stale delivery and stale clicks, including another app instance', async () => {
  const f = fixture();
  await f.notifier.show(event());
  f.switchAccount();
  f.notifier.activate(f.posted[0].data);
  await f.notifier.show(event());
  assert.equal(f.posted.length, 1);
  assert.deepEqual(f.opened, []);
  const g = fixture();
  g.notifier.activate({ ...f.posted[0].data, owner: 'another-tab' });
  assert.deepEqual(g.opened, []);
});

test('clearing while native permissions are pending prevents late notifications', async () => {
  const f = fixture({ native: true });
  let release;
  f.plugin.checkPermissions = () => new Promise(resolve => { release = resolve; });
  const showing = f.notifier.show(event());
  while (!release) await Promise.resolve();
  await f.notifier.clear();
  release({ display: 'granted' }); await showing;
  assert.equal(f.posted.length + f.fallbacks.length, 0);
});

test('clearing removes page notifications and only this app instance\'s SW notifications', async () => {
  const f = fixture({ serviceWorker: false });
  await f.notifier.show(event()); await f.notifier.clear();
  assert.equal(f.pages[0].closed, true);
  const g = fixture();
  const closed = [];
  g.registration.getNotifications = async () => [
    { tag: 'notetrace-trace:a', data: { owner: 'this-app' }, close() { closed.push('own'); } },
    { tag: 'notetrace-trace:b', data: { owner: 'another-tab' }, close() { closed.push('other'); } },
    { tag: 'note-reminder-7', close() { closed.push('reminder'); } },
  ];
  await g.notifier.clear();
  assert.deepEqual(closed, ['own']);
});

test('service-worker clicks focus the originating tab instead of an arbitrary NoteTrace tab', async () => {
  const handlers = {}, messages = [], focused = [];
  const tabs = ['other-tab', 'originating-tab'].map(id => ({ id, url: 'https://notes.example/notetrace/',
    focus: async () => focused.push(id), postMessage: message => messages.push({ id, message }) }));
  vm.runInNewContext(readFileSync(new URL('../public/sw-extras.js', import.meta.url), 'utf8'), {
    self: { addEventListener: (name, fn) => { handlers[name] = fn; }, registration: { scope: 'https://notes.example/notetrace/' },
      clients: { matchAll: async () => tabs } }, URL, URLSearchParams,
  });
  let clientId;
  handlers.message({ data: { type: 'trace-client-id' }, source: { id: 'originating-tab' }, ports: [{ postMessage: id => { clientId = id; } }] });
  assert.equal(clientId, 'originating-tab');
  let work;
  for (const kind of ['trace-result', 'trace-chat']) {
    handlers.notificationclick({ notification: { data: { kind, noteId: kind === 'trace-result' ? 7 : undefined, clientId }, close() {} }, waitUntil: promise => { work = promise; } });
    await work;
    assert.equal(focused.at(-1), 'originating-tab');
    assert.equal(messages.at(-1).id, 'originating-tab');
    assert.equal(messages.at(-1).message.type, 'trace-result');
    assert.equal(messages.at(-1).message.kind, kind);
  }
});


test('web delivery forwards sound policy for system and page notifications', async () => {
  for (const silent of [true, false]) for (const serviceWorker of [true, false]) {
    const f = fixture({ silent, serviceWorker });
    await f.notifier.show(event());
    const notification = serviceWorker ? f.posted[0] : f.pages[0];
    assert.equal(notification.silent, silent);
  }
});
