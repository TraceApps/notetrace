/**
 * The Android app finds and uses a server's SSO sign-in, and says so when it
 * can't (TraceApps/notetrace#36).
 *
 * The report: a server with SSO, and the app's first-run sign-in showed only
 * username and password. Behind a sign-in proxy (an Authentik or Authelia
 * outpost, Cloudflare Access) every request the app made got the proxy's own
 * web page with a 200: the server check took it for the server, the sign-in
 * options couldn't be read as JSON and were quietly dropped, and signing in
 * with a password showed "Unexpected token '<'". Settings > Server Connection
 * had no SSO at all.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { get } from 'svelte/store';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// localStorage, as the app has it.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const signin = await import('../src/lib/server-signin.js');
const WEB_PAGE = /^Something other than NoteTrace answered with a web page: often a sign-in proxy \(Authentik, Authelia, Cloudflare Access\), or this isn't your server's address\. Let the app reach \/api on your server\.$/;
const PROXY_PAGE = '<!doctype html><html><head><title>Sign in</title></head><body>Authentik</body></html>';
const GATEWAY_PAGE = '<html><body><h1>502 Bad Gateway</h1></body></html>';
const isWebPage = (e) => e.webPage === true && WEB_PAGE.test(e.message);
const isUnreachable = (status) => (e) => e.unreachable === true && e.status === status && !e.webPage && e.message === 'Could not reach server';

// CapacitorHttp as a table of answers: path -> { status, data }.
function fakeHttp(answers) {
  const calls = [];
  const answer = (method) => async (opts) => {
    calls.push({ method, ...opts });
    const path = new URL(opts.url).pathname;
    const a = answers[path];
    if (!a) throw new Error('Unable to resolve host');
    return typeof a === 'function' ? a(opts) : a;
  };
  return { get: answer('GET'), post: answer('POST'), calls };
}
const URL_ = 'https://notes.example.com';

test('a web page is a sign-in proxy only where a proxy sends one; a gateway error page is the server out of reach', async () => {
  assert.deepEqual(signin.serverJson({ status: 200, data: { ok: true } }), { ok: true });
  assert.deepEqual(signin.serverJson({ status: 200, data: '{"ok":true}' }), { ok: true }, 'CapacitorHttp may hand back text');
  assert.deepEqual(signin.serverJson({ status: 204, data: '' }), {});
  assert.deepEqual(signin.serverJson({ status: 500, data: { error: 'boom' } }), { error: 'boom' }, 'the server\'s own error comes back to judge');
  for (const status of [200, 401, 403]) {
    for (const data of [PROXY_PAGE, 'OK']) assert.throws(() => signin.serverJson({ status, data }), isWebPage, `${status} ${data}`);
  }
  // While the server restarts: a gateway's page, not a sign-in proxy.
  for (const status of [502, 504, 521, 404]) assert.throws(() => signin.serverJson({ status, data: GATEWAY_PAGE }), isUnreachable(status), String(status));
  // The same for fetch() (the sign-in page on the web).
  const res = (status, body) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(signin.responseJson(res(200, PROXY_PAGE)), isWebPage);
  await assert.rejects(signin.responseJson(res(502, GATEWAY_PAGE)), isUnreachable(502));
  assert.deepEqual(await signin.responseJson(new Response('{"error":"Invalid"}', { status: 401 })), { error: 'Invalid' });
});

test('the sign-in options come from /api/auth/status, and a failure to read them is an error, not an empty list', async () => {
  const sso = { oidc: { providers: [{ id: 1, display_name: 'OIDC' }], enable_email_password_login: true } };
  signin._useHttpForTests(fakeHttp({ '/api/auth/status': { status: 200, data: sso } }));
  const found = await signin.discoverSignIn(URL_);
  assert.deepEqual([found.providers, found.passwordLoginEnabled, found.status], [[{ id: 1, display_name: 'OIDC' }], true, sso]);
  signin._useHttpForTests(fakeHttp({ '/api/auth/status': { status: 200, data: JSON.stringify({ oidc: { providers: [], enable_email_password_login: false } }) } }));
  assert.equal((await signin.discoverSignIn(URL_)).passwordLoginEnabled, false);
  // A server from before SSO: password only.
  signin._useHttpForTests(fakeHttp({ '/api/auth/status': { status: 200, data: { active: true } } }));
  assert.deepEqual((await signin.discoverSignIn(URL_)).providers, []);
  // The reporter's case: a sign-in proxy's page.
  signin._useHttpForTests(fakeHttp({ '/api/auth/status': { status: 200, data: PROXY_PAGE } }));
  await assert.rejects(signin.discoverSignIn(URL_), isWebPage);
  // A gateway error, the server's own error, or no answer at all.
  signin._useHttpForTests(fakeHttp({ '/api/auth/status': { status: 502, data: GATEWAY_PAGE } }));
  await assert.rejects(signin.discoverSignIn(URL_), isUnreachable(502));
  signin._useHttpForTests(fakeHttp({ '/api/auth/status': { status: 500, data: { error: 'boom' } } }));
  await assert.rejects(signin.discoverSignIn(URL_), isUnreachable(500));
  signin._useHttpForTests(fakeHttp({}));
  await assert.rejects(signin.discoverSignIn(URL_), /Unable to resolve host/);
  // What the user reads is translatable: no English status inside it.
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.doesNotMatch(en.server_signin.options_failed, /\{reason\}/);
});

test('password sign-in says what went wrong, never "Unexpected token"', async () => {
  signin._useHttpForTests(fakeHttp({ '/api/auth/login': { status: 200, data: { token: 't', user: { id: 1 } } } }));
  assert.deepEqual(await signin.passwordSignIn(URL_, 'ann', 'pw'), { token: 't', user: { id: 1 } });
  for (const status of [200, 401, 403]) {
    signin._useHttpForTests(fakeHttp({ '/api/auth/login': { status, data: PROXY_PAGE } }));
    await assert.rejects(signin.passwordSignIn(URL_, 'ann', 'pw'), (e) => isWebPage(e) && !/Unexpected token/.test(e.message), String(status));
  }
  signin._useHttpForTests(fakeHttp({ '/api/auth/login': { status: 401, data: { error: 'Invalid username or password' } } }));
  await assert.rejects(signin.passwordSignIn(URL_, 'ann', 'pw'), /Invalid username or password/);
  signin._useHttpForTests(fakeHttp({ '/api/auth/login': { status: 504, data: GATEWAY_PAGE } }));
  await assert.rejects(signin.passwordSignIn(URL_, 'ann', 'pw'), isUnreachable(504));
});

test('an SSO sign-in from Settings: the account is asked of that server with the token', async () => {
  const http = fakeHttp({ '/api/auth/me': { status: 200, data: { user: { id: 7, username: 'ann' }, csrf: null } } });
  signin._useHttpForTests(http);
  assert.deepEqual(await signin.accountFor(URL_, 'tok'), { id: 7, username: 'ann' });
  assert.equal(http.calls[0].headers.Authorization, 'Bearer tok');
  signin._useHttpForTests(fakeHttp({ '/api/auth/me': { status: 200, data: { user: null } } }));
  await assert.rejects(signin.accountFor(URL_, 'tok'), /Sign-in failed/);
  signin._useHttpForTests(fakeHttp({ '/api/auth/me': { status: 502, data: GATEWAY_PAGE } }));
  await assert.rejects(signin.accountFor(URL_, 'tok'), isUnreachable(502));
  // The sign-in page: the app hand-off, back to the start of the app.
  const url = await signin.ssoSignInUrl(URL_, 3);
  assert.match(url, /^https:\/\/notes\.example\.com\/api\/auth\/oidc\/login\/3\?mobile=1&return=%23%2F&app_challenge=[\w-]+$/);
  const { challengeSent } = await import('../src/lib/oidc-app-handoff.js');
  assert.equal(challengeSent(), true, 'asking for a code is remembered');
  // Which server the deep link is for, for half an hour.
  signin.rememberSsoConnect(URL_);
  assert.equal(signin.pendingSsoConnect().url, URL_);
  signin.forgetSsoConnect();
  assert.equal(signin.pendingSsoConnect(), null);
  store.set('note:ssoConnect', JSON.stringify({ url: URL_, at: Date.now() - 31 * 60 * 1000 }));
  assert.equal(signin.pendingSsoConnect(), null, 'an old one is forgotten');
});

test('a Settings sign-in takes only the code it asked for, never a token another app hands over', () => {
  const act = signin.ssoCallbackAction;
  const connecting = { url: URL_ };
  // Settings, having asked for a code: a bare token is refused, whoever sent it.
  assert.deepEqual(act({ token: 'forged', connecting, challengeSent: true }), { do: 'refuse' });
  assert.deepEqual(act({ code: 'c1', connecting, challengeSent: true }), { do: 'redeem', server: URL_ });
  assert.deepEqual(act({ error: 'denied', code: 'c1', connecting, challengeSent: true }), { do: 'error' });
  // Without WebCrypto no code was asked for: the token is the only answer.
  assert.deepEqual(act({ token: 't', connecting, challengeSent: false }), { do: 'token' });
  // First run and after Log Out: a server from before the code hand-off (1.0)
  // answers with a token, so it's still taken there.
  assert.deepEqual(act({ token: 't', connecting: null, challengeSent: true }), { do: 'token' });
  assert.deepEqual(act({ code: 'c1', connecting: null, challengeSent: true }), { do: 'redeem', server: null });
  assert.deepEqual(act({}), { do: 'none' });
  // App.svelte follows it, and asks before the code is spent.
  const app = read('../src/App.svelte');
  assert.match(app, /const action = ssoCallbackAction\(\{ code, token, error: errMsg, connecting, challengeSent: challengeSent\(\) \}\);/);
  assert.match(app, /if \(action\.do === 'refuse'\) \{\n[^\n]*server_signin\.token_refused[^\n]*\n\s*return;\n\s*\}/);
  assert.match(app, /const data = await redeemHandoff\(code, action\.server\);/);
  assert.match(app, /const connecting = getNativeMode\(\) === 'local' \? pendingSsoConnect\(\) : null;/);
  // Server Connection opens once the first screen is chosen, even from a cold start.
  assert.match(app, /if \(_setupRouted\) await \(await import\('svelte-spa-router'\)\)\.push\('\/settings\/serverconn'\);/);
  assert.match(app, /_setupRouted = true;\n[^\n]*\n[^\n]*\n\s*if \(isNative && getStore\(ssoConnectResult\)\) push\('\/settings\/serverconn'\);/);
  const handoff = read('../src/lib/oidc-app-handoff.js');
  assert.match(handoff, /fetch\(server \? `\$\{server\}\/api\/auth\/oidc\/handoff` : apiUrl\('\/api\/auth\/oidc\/handoff'\)/);
});

test('Settings options: typing clears them at once, an old answer is dropped, a half-typed host is no error', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const asked = [];
  const answers = {};
  const discover = (url) => new Promise((resolve, reject) => { asked.push(url); answers[url] = { resolve, reject }; });
  const opts = signin.createSignInOptions({ discover, delay: 700 });
  const now = () => get(opts);
  const flush = () => new Promise((r) => setImmediate(r));
  // Server A's buttons.
  opts.typed('https://a.example.com');
  t.mock.timers.tick(700);
  answers['https://a.example.com'].resolve({ providers: [{ id: 1 }], passwordLoginEnabled: true });
  await flush();
  assert.equal(now().state, 'ok');
  assert.equal(now().providers.length, 1);
  // Typing B: A's buttons go at once, before B is even asked.
  opts.typed('https://b.example.com');
  assert.deepEqual([now().state, now().providers, now().url], ['', [], '']);
  t.mock.timers.tick(700);
  // A late answer for an address no longer in the field is dropped.
  opts.typed('https://c.example.com');
  answers['https://b.example.com'].resolve({ providers: [{ id: 2 }], passwordLoginEnabled: false });
  await flush();
  assert.deepEqual([now().providers, now().passwordLoginEnabled], [[], true]);
  // A half-typed host isn't looked up while typing; once settled, a failure
  // while typing shows nothing; leaving the field says it.
  const before = asked.length;
  opts.typed('https://notes');
  t.mock.timers.tick(700);
  assert.equal(asked.length, before, 'no request for a host without a dot');
  opts.typed('https://notes.exa');
  t.mock.timers.tick(700);
  answers['https://notes.exa'].reject(new Error('Unable to resolve host'));
  await flush();
  assert.deepEqual([now().state, now().error], ['', '']);
  opts.left('https://notes.exa');
  answers['https://notes.exa'].reject(new Error('Unable to resolve host'));
  await flush();
  assert.equal(now().state, 'failed');
  assert.match(now().error, /sign-in options/);
  // Retry asks again; a cleared field shows nothing.
  opts.retry();
  assert.equal(now().state, 'checking');
  opts.typed('');
  assert.deepEqual(now(), { state: '', providers: [], passwordLoginEnabled: true, error: '', url: '' });
  // A name on the home network: looked up when the field is left.
  opts.left('http://nas:3004');
  assert.equal(asked.at(-1), 'http://nas:3004');
  opts.stop();
  // And Server Connection uses it.
  const src = read('../src/components/settings/SettingsServerConnection.svelte');
  assert.match(src, /on:input=\{\(\) => signInOptions\.typed\(serverUrl\)\}/);
  assert.match(src, /on:blur=\{\(\) => signInOptions\.left\(serverUrl\)\}/);
  assert.match(src, /on:click=\{\(\) => signInOptions\.retry\(\)\}/);
});

test('an SSO session hint never goes to another server: a password connect and Disconnect clear it', () => {
  signin.keepSsoLogoutHint({ providerId: '1', idTokenHint: 'h' });
  assert.equal(store.get('note:oidc_logout_hint'), '{"providerId":"1","idTokenHint":"h"}');
  signin.keepSsoLogoutHint(null);
  assert.equal(store.has('note:oidc_logout_hint'), false);
  signin.keepSsoLogoutHint({ providerId: '1' });
  assert.equal(store.has('note:oidc_logout_hint'), false, 'half a hint is none');
  const src = read('../src/components/settings/SettingsServerConnection.svelte');
  assert.match(src, /const body = await passwordSignIn\(url, username\.trim\(\), password\);\n\s*_pendingLogoutHint = null;/);
  assert.match(src, /keepSsoLogoutHint\(_pendingLogoutHint\);\n\s*setServerUrl\(_pendingServerUrl\);/);
  const disconnect = src.slice(src.indexOf('async function disconnect'), src.indexOf('</script>'));
  assert.match(disconnect, /keepSsoLogoutHint\(null\);/);
});

test('first run: a web page fails the server check, and unreadable sign-in options are said with Retry', () => {
  const src = read('../src/routes/NativeSetup.svelte');
  assert.doesNotMatch(src, /leave defaults/, 'no quiet fallback to a password-only form');
  assert.match(src, /if \(healthNeedsSetup\(healthRes\)\)[^\n]*\n\s*checkHealth\(healthRes\);/);
  assert.match(src, /validatedUrl = url;\n\s*await loadSignInOptions\(\);\n\s*step = 'server-auth';/);
  assert.match(src, /\(\{ providers, passwordLoginEnabled \} = await discoverSignIn\(validatedUrl\)\);/);
  assert.match(src, /optionsError = e\?\.webPage \? e\.message : \$_\('server_signin\.options_failed'\);/);
  assert.match(src, /\{#if optionsError\}[\s\S]{0,400}on:click=\{retrySignInOptions\}/);
  assert.match(src, /passwordSignIn\(validatedUrl, username\.trim\(\), password\)/);
  assert.match(src, /Browser\.open\(\{ url: await ssoSignInUrl\(validatedUrl, providerId\)/);
});

test('Settings > Server Connection offers SSO, and an SSO sign-in moves the notes over as a password one does', () => {
  const src = read('../src/components/settings/SettingsServerConnection.svelte');
  // Both ways in reach the same steps after signing in.
  const after = src.slice(src.indexOf('async function _afterSignIn'), src.indexOf('// Apply the user'));
  for (const step of ['cameFromThisAccount', 'if (_sameAccount == null) { await cancelMerge(); return; }', 'setAuthToken(token)', 'countLocalData', "mergeStep = 'ask-settings'", '_finalizeConnect()']) {
    assert.ok(after.includes(step), step);
  }
  assert.match(src, /await _afterSignIn\(url, body\.token, body\.user \|\| null\);/);
  assert.match(src, /const user = await accountFor\(url, token\);[\s\S]{0,200}await _afterSignIn\(url, token, user\);/);
  // SSO: the server is checked, remembered, then the browser opens.
  assert.match(src, /if \(!\(await _serverReady\(url\)\)\) return;\n\s*rememberSsoConnect\(url\);/);
  assert.match(src, /checkHealth\(health\);/);
  assert.match(src, /\{:else if optionsState === 'failed'\}[\s\S]{0,300}server_signin\.retry/);
  assert.match(src, /on:click=\{\(\) => connectWithSso\(p\.id\)\}/);
  assert.match(src, /\{#if passwordLoginEnabled\}\n\s*<label class="form-group">\n\s*<span class="form-label">\{\$_\('settings_server_conn\.username'\)\}/);
});

test('the sign-in page says when its options can\'t be read, and a web page in place of the server', () => {
  const src = read('../src/routes/Login.svelte');
  // The app asks natively (a proxy page is said as such, not "Failed to fetch").
  assert.match(src, /if \(isNative\) data = \(await discoverSignIn\(getServerUrl\(\)\)\)\.status;/);
  assert.match(src, /data = await responseJson\(r\);/);
  assert.match(src, /\{#if optionsError\}[\s\S]{0,300}on:click=\{loadSignInOptions\}/);
  assert.match(src, /const data = await responseJson\(res\);\n\s*if \(!res\.ok\)/);
  assert.match(src, /showError\(e\?\.webPage \? e\.message : \$_\('common\.errors\.cant_reach_server'\)\)/);
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.match(en.server_signin.web_page, WEB_PAGE);
  assert.equal(en.server_signin.retry, 'Retry');
  assert.ok(en.server_signin.token_refused);
});

test('a second tap on an SSO button doesn\'t open a second sign-in', () => {
  // Each would replace the code's secret, and the first hand-off would fail.
  const settings = read('../src/components/settings/SettingsServerConnection.svelte');
  assert.match(settings, /async function connectWithSso\(providerId\) \{\n(\s*\/\/[^\n]*\n)*\s*if \(busy\) return;\n[^\n]*\n\s*busy = true;/);
  assert.match(settings, /on:click=\{\(\) => connectWithSso\(p\.id\)\} disabled=\{busy\}/);
  const setup = read('../src/routes/NativeSetup.svelte');
  const oidc = setup.slice(setup.indexOf('async function loginWithOidc'), setup.indexOf('function backToChoose'));
  assert.match(oidc, /if \(connecting\) return;\n\s*connecting = true;/);
  assert.match(oidc, /\} finally \{\n\s*connecting = false;\n\s*\}/, 'and ready again if opening failed');
  assert.match(setup, /on:click=\{\(\) => loginWithOidc\(p\.id\)\} disabled=\{connecting\}/);
  const login = read('../src/routes/Login.svelte');
  assert.match(login, /if \(ssoOpening\) return;\n\s*ssoOpening = true;/);
  assert.match(login, /\} finally \{\n\s*ssoOpening = false;\n\s*\}/);
  assert.match(login, /on:click=\{\(\) => startOidc\(p\.id\)\} disabled=\{ssoOpening\}/);
});

test('a Settings SSO sign-in survives the app being closed while the browser is open', async () => {
  // Kept on the device, not in memory: a fresh start of the app (a new copy
  // of the module) still knows which server the link is for.
  store.clear();
  signin.rememberSsoConnect(URL_);
  const fresh = await import('../src/lib/server-signin.js?cold-start');
  assert.notEqual(fresh, signin);
  assert.equal(fresh.pendingSsoConnect().url, URL_);
  assert.deepEqual(fresh.ssoCallbackAction({ code: 'c', connecting: fresh.pendingSsoConnect(), challengeSent: true }), { do: 'redeem', server: URL_ });
  // Over when the link comes back, or a password connect is made instead.
  const app = read('../src/App.svelte');
  assert.match(app, /if \(connecting && action\.do !== 'none'\) forgetSsoConnect\(\);/);
  assert.match(read('../src/components/settings/SettingsServerConnection.svelte'), /_pendingLogoutHint = null;\n\s*forgetSsoConnect\(\);/);
  fresh.forgetSsoConnect();
  assert.equal(signin.pendingSsoConnect(), null);
});

test('the native HTTP plugin is handed over as plain methods, so awaiting it settles', async () => {
  const { _wrapHttp } = await import('../src/lib/server-signin.js');
  // Like a Capacitor plugin: every property is a function, `then` included,
  // and that `then` never calls back.
  const plugin = new Proxy({}, { get: (_, key) => (key === 'then' ? () => {} : async (o) => ({ status: 200, data: { key, url: o.url } })) });
  const settles = (p) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), 200))]);
  assert.equal(await settles((async () => plugin)()), false, 'the plugin itself never settles');
  const http = await (async () => _wrapHttp(plugin))();
  assert.deepEqual(await http.get({ url: 'https://x' }), { status: 200, data: { key: 'get', url: 'https://x' } });
  assert.deepEqual((await http.post({ url: 'https://y' })).data.key, 'post');
});

test('the server check reads the reply first: an outpost 401 page is a sign-in proxy, a gateway 502 is out of reach', async () => {
  const { checkHealth } = await import('../src/lib/server-signin.js');
  const page = '<!doctype html><title>Sign in</title>';
  assert.deepEqual(checkHealth({ status: 200, data: { ok: true } }), { ok: true });
  for (const status of [200, 401, 403]) assert.throws(() => checkHealth({ status, data: page }), (e) => e.webPage === true, `${status} page`);
  assert.throws(() => checkHealth({ status: 200, data: '' }), (e) => e.webPage === true, 'an empty 200 is not NoteTrace');
  assert.throws(() => checkHealth({ status: 502, data: page }), (e) => e.unreachable === true && e.status === 502);
  assert.throws(() => checkHealth({ status: 503, data: { error: 'down' } }), (e) => e.unreachable === true);
});
