/**
 * The diagnostic log (Settings > Diagnostics, attached to bug reports)
 * never holds a secret, whatever a message carries.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { redactSecrets } = await import('../src/lib/log-capture.js');

test('secrets are hidden; everything else stays readable', () => {
  const hidden = [
    ['[settings] pushing aiApiKey="sk-proj-abcdefghijklmnop1234"', 'sk-proj'],
    ['notetrace://oidc-callback/?code=abc123&id_token_hint=eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl', 'abc123'],
    ['notetrace://oidc-callback/?token=eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.c2lnbmF0dXJlZWU', 'eyJhbGciOiJIUzI1NiJ9'],
    ['Authorization: Bearer abc.def', 'abc.def'],
    ['{"ntfyToken":"t0ken","gotifyToken":"g0t"}', 't0ken'],
    ['password: hunter2', 'hunter2'],
    ['loose sk-abcdefghijklmnopqrstu in text', 'sk-abcdefghijklmnopqrstu'],
    ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA'],
    ['https://user:pass@host.example/x', 'user:pass'],
    ['key AIzaSyA1234567890abcdefghijklmnopqrstuv', 'AIzaSyA1234567890'],
    ['hf_abcdefghijklmnopqrstuvwx', 'hf_abcdefghijklmnop'],
    ['smtpPass=abc123', 'abc123'],
    ['SMTP_PASS=abc123', 'abc123'],
    ['pin: 4321', '4321'],
    ['"password": "correct horse battery"', 'correct horse'],
    ['password="p@ss&word"', 'p@ss'],
    ['https://hooks.slack.com/services/T0/B0/xyzsecret', 'xyzsecret'],
    ['ntfyTopic=mysecrettopic', 'mysecrettopic'],
  ];
  for (const [line, secret] of hidden) assert.ok(!redactSecrets(line).includes(secret), `${line} -> ${redactSecrets(line)}`);
  for (const line of ['{"code":"SQLITE_CONSTRAINT"}', 'Error code: 401', 'authenticated: false', 'author: me', 'key=notes', '{"key":"theme"}', 'pinned=1', 'keyboardShortcuts=true', 'barcode: 99', '[sync] server unreachable: host=10.0.2.2 network=wifi status=500', '[settings] pushing aiApiKey (changed) to /api/settings', 'monkey: banana']) {
    assert.equal(redactSecrets(line), line);
  }
  assert.equal(redactSecrets('aiApiKey=sk-xx'), 'aiApiKey=[hidden]', 'hidden once, never mangled');
});
