import test from 'node:test';
import assert from 'node:assert/strict';
import { describeConnectionIssue } from '../src/lib/connection-message.js';

// Stand-in for svelte-i18n's $_: gives back the key, with any values.
const t = (key, opts) => (opts?.values ? `${key}:${JSON.stringify(opts.values)}` : key);

test('no network reads as waiting, not as a failure', () => {
  const m = describeConnectionIssue({ kind: 'no_network' }, t);
  assert.equal(m.tone, 'wait');
  assert.match(m.title, /no_network_title/);
  assert.match(m.detail, /reconnect/);
});

test('a server that can\'t be reached, or answers badly, reads as a failure', () => {
  assert.equal(describeConnectionIssue({ kind: 'unreachable', host: 'notes.example.com' }, t).tone, 'bad');
  assert.equal(describeConnectionIssue({ kind: 'server_error', status: 502 }, t).tone, 'bad');
});

test('on mobile data the detail says so, and edits are kept locally when asked', () => {
  const m = describeConnectionIssue({ kind: 'unreachable', connectionType: 'cellular', host: 'h' }, t, true);
  assert.match(m.detail, /mobile_data/);
  assert.match(m.detail, /saved_locally/);
});

test('no issue, no message', () => {
  assert.equal(describeConnectionIssue(null, t), null);
});
