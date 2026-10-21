import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import { readFileSync } from 'node:fs';
import { createTraceSessions, traceNoteKey } from '../src/lib/trace-sessions.js';

test('explicit cancellation aborts the provider and ignores a late reply before retry', async () => {
  let completions = 0, signal;
  const sessions = createTraceSessions({ onComplete: () => completions++ });
  const session = sessions.forNote('cancelled');
  const response = deferred();
  const pending = session.run('tidy', { body: 'original', request: args => { signal = args.signal; return response.promise; } });
  session.reset();
  assert.equal(signal.aborted, true);
  assert.equal(get(session).busy, false);
  await session.run('tidy', { body: 'newer', request: async args => { assert.equal(args.signal.aborted, false); return 'New answer'; } });
  response.resolve('Obsolete answer'); await pending;
  assert.equal(get(session).result, 'New answer');
  assert.equal(completions, 1);
});

test('a provider rejection after cancellation produces no error or notification', async () => {
  let completions = 0;
  const session = createTraceSessions({ onComplete: () => completions++ }).forNote('reject');
  const response = deferred();
  const pending = session.run('tidy', { body: 'draft', request: () => response.promise });
  session.reset(); response.reject(new Error('AbortError')); await pending;
  assert.equal(get(session).failure, '');
  assert.equal(get(session).action, null);
  assert.equal(completions, 0);
});

test('account reset aborts every in-flight note request', async () => {
  const sessions = createTraceSessions();
  const signals = [], responses = [deferred(), deferred()];
  const runs = responses.map((response, i) => sessions.forNote(i).run('tidy', { body: 'draft', request: args => { signals.push(args.signal); return response.promise; } }));
  sessions.clear();
  assert.equal(signals.every(signal => signal.aborted), true);
  responses.forEach(response => response.resolve('old account')); await Promise.all(runs);
  assert.equal(sessions.hasWork(0), false);
});

test('background work retains the source snapshot used to protect newer note text', async () => {
  const session = createTraceSessions().forNote('background');
  const leave = session.view(), response = deferred();
  let signal;
  const pending = session.run('tidy', { body: 'source snapshot', request: args => { signal = args.signal; return response.promise; } });
  leave();
  assert.equal(signal.aborted, false);
  response.resolve('Retained answer'); await pending;
  assert.equal(get(session).askedBody, 'source snapshot');
  assert.equal(get(session).result, 'Retained answer');
  const ui = readFileSync(new URL('../src/components/notes/TraceActions.svelte', import.meta.url), 'utf8');
  assert.match(ui, /body !== askedBody/);
  assert.match(ui, /on:click=\{\(\) => dispatch\('close'\)\}\>\{\$_\('trace_actions.background'\)\}/);
  assert.match(ui, /stop\(\); dispatch\('close'\)/);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('a request finishes with no popup subscribed and is restored when the note reopens', async () => {
  const sessions = createTraceSessions();
  const session = sessions.forNote('note-a');
  const response = deferred();
  const unsubscribe = session.subscribe(() => {});
  const running = session.run('tidy', { title: 'Trip', body: 'pack socks', request: () => response.promise });
  unsubscribe();
  assert.equal(get(sessions.forNote('note-a')).busy, true);
  response.resolve('Pack socks.');
  await running;
  const restored = get(sessions.forNote('note-a'));
  assert.equal(restored.result, 'Pack socks.');
  assert.equal(restored.action, 'tidy');
  assert.equal(restored.busy, false);
  assert.equal(sessions.hasWork('note-a'), true);
});

test('concurrent notes keep their own request, instruction and result', async () => {
  const sessions = createTraceSessions();
  const a = sessions.forNote('a'), b = sessions.forNote('b');
  const first = deferred(), second = deferred();
  a.patch({ instruction: 'Translate to Spanish', asking: true });
  let prompt;
  const one = a.run('custom', { title: 'A', body: 'hello', request: args => { prompt = args.prompt; return first.promise; } });
  const two = b.run('expand', { title: 'B', body: 'buy milk', request: () => second.promise });
  second.resolve('Buy some milk.'); await two;
  assert.equal(get(a).busy, true);
  assert.equal(get(b).result, 'Buy some milk.');
  first.resolve('Hola.'); await one;
  assert.match(prompt, /Translate to Spanish/);
  assert.equal(get(a).instruction, 'Translate to Spanish');
  assert.equal(get(a).result, 'Hola.');
  assert.equal(get(b).result, 'Buy some milk.');
});

test('reopening a busy session does not duplicate the provider request', async () => {
  const session = createTraceSessions().forNote('a');
  const response = deferred();
  let calls = 0;
  const args = { title: '', body: 'draft', request: () => { calls++; return response.promise; } };
  const running = session.run('tidy', args);
  await session.run('tidy', args);
  assert.equal(calls, 1);
  response.resolve('Draft.'); await running;
});

test('provider errors and empty replies survive closing and can be retried', async () => {
  const sessions = createTraceSessions();
  const session = sessions.forNote('a');
  await session.run('tidy', { body: 'text', request: async () => { throw new Error('Provider offline'); } });
  assert.equal(get(sessions.forNote('a')).error, 'Provider offline');
  assert.equal(get(session).busy, false);
  await session.run('tidy', { body: 'text', request: async () => '' });
  assert.equal(get(session).failure, 'empty');
  await session.run('tidy', { body: 'text', request: async () => 'Recovered.' });
  assert.equal(get(session).result, 'Recovered.');
  assert.equal(get(session).failure, '');
});

test('custom drafts survive closing without starting a request', () => {
  const sessions = createTraceSessions();
  sessions.forNote('a').patch({ instruction: 'Make this a table', asking: true });
  assert.equal(get(sessions.forNote('a')).instruction, 'Make this a table');
  assert.equal(get(sessions.forNote('a')).asking, true);
});

test('account reset clears sessions and late responses cannot bring old data back', async () => {
  const sessions = createTraceSessions();
  const old = sessions.forNote('a'), response = deferred();
  const running = old.run('tidy', { body: 'private', request: () => response.promise });
  sessions.clear();
  response.resolve('Old private reply'); await running;
  assert.equal(get(old).result, '');
  assert.equal(get(sessions.forNote('a')).result, '');
  assert.equal(sessions.hasWork('a'), false);
});

test('note session keys distinguish accounts and servers', () => {
  const before = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key) ?? null };
  try {
    values.set('wl:userId', '1'); values.set('note:serverUrl', 'https://one.example');
    const first = traceNoteKey(7);
    values.set('wl:userId', '2'); assert.notEqual(traceNoteKey(7), first);
    values.set('wl:userId', '1'); values.set('note:serverUrl', 'https://two.example');
    assert.notEqual(traceNoteKey(7), first);
    assert.equal(traceNoteKey(null), null);
  } finally {
    if (before === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = before;
  }
});

test('completion is emitted once after leaving the popup, including errors, without changing the result', async () => {
  const completed = [];
  const sessions = createTraceSessions({ onComplete: event => { completed.push(event); throw new Error('No OS permission'); } });
  const session = sessions.forNote('a');
  const leave = session.view();
  const response = deferred();
  const running = session.run('tidy', { noteId: 7, title: 'Trip', body: 'socks', request: () => response.promise });
  leave(); response.resolve('Pack socks.'); await running;
  assert.equal(completed.length, 1);
  assert.equal(completed[0].noteId, 7);
  assert.equal(completed[0].isViewing(), false);
  assert.equal(completed[0].failure, '');
  assert.equal(get(session).result, 'Pack socks.');
  assert.equal(get(session).failure, '');
  await session.run('tidy', { noteId: 7, body: 'socks', request: async () => { throw new Error('Provider offline'); } });
  assert.equal(completed[1].failure, 'failed');
  assert.equal(completed[0].isCurrent(), false);
});

test('a result still being viewed is identified, and a cleared generation never emits completion', async () => {
  const completed = [];
  const sessions = createTraceSessions({ onComplete: event => completed.push(event) });
  const session = sessions.forNote('a');
  const leave = session.view();
  await session.run('tidy', { body: 'socks', request: async () => 'Pack socks.' });
  assert.equal(completed[0].isViewing(), true);
  leave();
  const response = deferred();
  const running = session.run('tidy', { body: 'socks', request: () => response.promise });
  sessions.clear(); response.resolve('Old reply'); await running;
  assert.equal(completed.length, 1);
});
