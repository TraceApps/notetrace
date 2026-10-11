/**
 * Which account a request is answered as.
 *
 * The Android app sends its account's token in the Authorization header,
 * and its native HTTP layer (CapacitorHttp) can also send the sign-in
 * cookie an earlier account left in the phone's cookie jar. The server
 * read that cookie first, so after one account signed out and another
 * signed in, the second account's requests were answered as the first.
 * Our own bearer token decides now, expired or not. A bearer that isn't
 * ours (a reverse proxy or identity provider in front of the web app can
 * add one) is left alone: the cookie signs in, and its CSRF check applies.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'session-source-')), 'test.db');
const { default: db } = await import('../server/db.js');
const { authenticate, signToken, JWT_SECRET } = await import('../server/middleware/auth.js');
const { csrfProtect } = await import('../server/middleware/csrf.js');
const jwt = createRequire(new URL('../server/package.json', import.meta.url))('jsonwebtoken');

const user = (name) => {
  db.prepare(`INSERT INTO users (username, role) VALUES (?, 'user')`).run(name);
  return db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
};
const a = user('alice'), b = user('bob');
const ta = signToken({ id: a, username: 'alice', role: 'user' });
const tb = signToken({ id: b, username: 'bob', role: 'user' });
const expired = jwt.sign({ id: a, username: 'alice', role: 'user', csrf: 'x', exp: Math.floor(Date.now() / 1000) - 60 }, JWT_SECRET);
const early = jwt.sign({ id: a, username: 'alice', role: 'user', csrf: 'x', nbf: Math.floor(Date.now() / 1000) + 3600 }, JWT_SECRET);
const idp = jwt.sign({ sub: 'someone', email: 'alice@example.com' }, 'the-identity-providers-own-key');

const run = (headers, cookies, method = 'GET', path = '/api/notes') => {
  const req = { method, path, headers, cookies };
  authenticate(req, {}, () => {});
  let status = 200;
  const res = { status(c) { status = c; return { json() {} }; } };
  csrfProtect(req, res, () => {});
  return { who: req.user?.id ?? null, via: req.authVia ?? null, status };
};
const who = (h, c) => run(h, c).who;

test("our bearer token decides the session, never another account's cookie", () => {
  assert.equal(who({ authorization: `Bearer ${ta}` }, { note_token: tb }), a, "the bearer's account, not the cookie's");
  assert.equal(who({ authorization: `Bearer ${expired}` }, { note_token: tb }), null, 'our expired bearer is no session, never the cookie');
  assert.equal(who({ authorization: `Bearer ${early}` }, { note_token: tb }), null, 'nor one not valid yet');
  assert.equal(who({ authorization: `Bearer ${ta}` }, {}), a);
  assert.equal(run({ authorization: `Bearer ${ta}` }, { note_token: tb }).via, 'bearer');
});

test("a bearer that isn't ours leaves the web on its cookie", () => {
  assert.equal(who({ authorization: `Bearer ${idp}` }, { note_token: tb }), b, "an identity provider's token: the cookie's account");
  assert.equal(who({ authorization: 'Bearer opaque-proxy-token' }, { note_token: tb }), b, "a proxy's opaque token: the cookie's account");
  assert.equal(run({ authorization: `Bearer ${idp}` }, { note_token: tb }).via, 'cookie');
  assert.equal(who({ authorization: `Bearer ${idp}` }, {}), null);
  assert.equal(who({}, { note_token: tb }), b, 'the web signs in with its cookie');
  assert.equal(run({}, { note_token: tb }).via, 'cookie');
  assert.equal(who({}, { note_token: 'not-a-token' }), null);
  assert.equal(run({}, {}).via, null);
});

test('a cookie session keeps its CSRF check whatever bearer comes along; ours needs none', () => {
  const csrfB = jwt.decode(tb).csrf;
  assert.equal(run({ authorization: `Bearer ${idp}` }, { note_token: tb }, 'POST').status, 403, "someone else's bearer doesn't skip the cookie's CSRF check");
  assert.equal(run({ authorization: 'Bearer opaque-proxy-token' }, { note_token: tb }, 'POST').status, 403);
  assert.equal(run({ authorization: `Bearer ${idp}`, 'x-csrf-token': csrfB }, { note_token: tb }, 'POST').status, 200);
  assert.equal(run({}, { note_token: tb }, 'POST').status, 403, 'the web without its CSRF token, as before');
  assert.equal(run({ 'x-csrf-token': csrfB }, { note_token: tb }, 'POST').status, 200);
  assert.equal(run({ authorization: `Bearer ${ta}` }, { note_token: tb }, 'POST').status, 200, 'our bearer needs none');
  assert.equal(run({ authorization: `Bearer ${ta}` }, {}, 'POST').status, 200);
});

test('the MCP endpoint signs in by its API token, with or without a cookie, as before', () => {
  for (const cookies of [{}, { note_token: tb }]) {
    assert.equal(run({ authorization: 'Bearer nt_api_token' }, cookies, 'POST', '/api/mcp').status, 200);
    assert.equal(run({ authorization: 'Bearer nt_api_token' }, cookies, 'POST', '/api/mcp/').status, 200);
  }
  assert.equal(run({}, { note_token: tb }, 'POST', '/api/mcp').status, 403, 'a cookie alone gets no pass there');
  assert.equal(run({ authorization: 'Bearer nt_api_token' }, { note_token: tb }, 'POST', '/api/mcpx').status, 403, 'only that endpoint');
});
