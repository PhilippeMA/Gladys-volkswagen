import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENT_ID,
  VwAuthError,
  decodeEntities,
  isPortalLandingPage,
  login,
  marketingConsentCallback,
  parseForm,
  parseTemplateModel,
} from '../src/vw/auth.js';
import { CookieJar } from '../src/vw/http.js';
import { createFakeVolkswagen } from './helpers/fakeVolkswagen.js';

const credentials = { email: 'driver@example.com', password: 'secret-password' };
const PORTAL_API = 'https://eu-data-act.drivesomethinggreater.com/proxy_api/';

test('signs in to the portal and keeps its session cookie', async () => {
  const vw = createFakeVolkswagen();
  const session = await login({ ...credentials, fetch: vw.fetch });
  assert.equal(vw.logins, 1);
  assert.equal(session.jar.value('access_token', PORTAL_API), 'session-1');
  const authorize = vw.requests[0];
  assert.match(authorize.path, /^\/oidc\/v1\/authorize\?/);
  assert.ok(authorize.path.includes(encodeURIComponent(CLIENT_ID)), 'the portal client');
});

test('the retired app client is not used any more', async () => {
  const vw = createFakeVolkswagen();
  await login({ ...credentials, fetch: vw.fetch });
  assert.ok(!vw.requests.some((r) => r.path.includes('a24fba63')));
  assert.ok(!vw.requests.some((r) => r.host === 'emea.bff.cariad.digital'));
});

test('the optional marketing consent is skipped through its callback', async () => {
  const vw = createFakeVolkswagen({ marketingConsent: true });
  const session = await login({ ...credentials, fetch: vw.fetch });
  assert.equal(session.jar.value('access_token', PORTAL_API), 'session-1');
});

test('a wrong password is an account error', async () => {
  const vw = createFakeVolkswagen();
  await assert.rejects(
    login({ ...credentials, password: 'wrong', fetch: vw.fetch }),
    (err) => err instanceof VwAuthError && /password/.test(err.userMessage.en),
  );
  assert.equal(vw.logins, 0);
});

test('an unknown account is an account error', async () => {
  const vw = createFakeVolkswagen();
  await assert.rejects(
    login({ ...credentials, email: 'nobody@example.com', fetch: vw.fetch }),
    (err) => err instanceof VwAuthError && /password/.test(err.userMessage.en),
  );
});

test('a portal never authorised in a browser says what to do', async () => {
  const vw = createFakeVolkswagen({ portalConsent: false });
  await assert.rejects(
    login({ ...credentials, fetch: vw.fetch }),
    (err) => err instanceof VwAuthError && /portal/.test(err.userMessage.en),
  );
});

test('missing credentials never reach Volkswagen', async () => {
  const vw = createFakeVolkswagen();
  await assert.rejects(login({ email: '', password: '', fetch: vw.fetch }), VwAuthError);
  assert.equal(vw.requests.length, 0);
});

test('form and script parsing', () => {
  const form = parseForm(
    '<form id="other"></form><form id="emailPasswordForm" action="/a?x=1&amp;y=2"><input name="hmac" value="h&#39;1"><input name="email"></form>',
    'emailPasswordForm',
  );
  assert.deepEqual(form, { action: '/a?x=1&y=2', data: { hmac: "h'1", email: '' } });
  assert.equal(parseForm('<html></html>', 'emailPasswordForm'), undefined);

  const template = parseTemplateModel(
    '<script>\n  templateModel: {"hmac":"h","nested":{"a":"}"}},\n  csrf_token: \'c\',\n</script>',
  );
  assert.deepEqual(template, { model: { hmac: 'h', nested: { a: '}' } }, csrf: 'c' });
  assert.equal(decodeEntities('&lt;a&gt; &#x41;'), '<a> A');
});

test('landing page and marketing callback detection', () => {
  const portal = 'https://eu-data-act.drivesomethinggreater.com';
  assert.equal(isPortalLandingPage(`${portal}/de/en/user.html`), true);
  assert.equal(isPortalLandingPage(`${portal}/content/euda/fr/fr/user.html`), true);
  assert.equal(isPortalLandingPage(`${portal}/login`), false);

  const callback = 'https://identity.vwgroup.io/oidc/v1/oauth/client/callback?a=1';
  const page = `https://identity.vwgroup.io/signin-service/v1/consent/marketing/x?callback=${encodeURIComponent(callback)}`;
  assert.equal(marketingConsentCallback(page), callback);
  // A callback elsewhere than on the identity provider is refused.
  const evil = `https://identity.vwgroup.io/signin-service/v1/consent/marketing/x?callback=${encodeURIComponent('https://evil.example/oidc/v1/oauth/client/callback')}`;
  assert.equal(marketingConsentCallback(evil), undefined);
  assert.equal(marketingConsentCallback(`${portal}/login`), undefined);
});

test('the cookie jar honors domains and expiries', () => {
  const jar = new CookieJar();
  const headers = new Headers();
  headers.append('set-cookie', 'a=1; Path=/');
  headers.append('set-cookie', 'b=2; Domain=.vwgroup.io; Path=/');
  jar.store('https://identity.vwgroup.io/x', { headers });
  assert.equal(jar.header('https://identity.vwgroup.io/y'), 'a=1; b=2');
  assert.equal(jar.header('https://other.vwgroup.io/'), 'b=2');
  assert.equal(jar.header('https://example.com/'), undefined);
  assert.equal(jar.value('b', 'https://identity.vwgroup.io/'), '2');

  const expire = new Headers();
  expire.append('set-cookie', 'a=; Max-Age=0');
  jar.store('https://identity.vwgroup.io/x', { headers: expire });
  assert.equal(jar.header('https://identity.vwgroup.io/y'), 'b=2');
});
