import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VwAuthError,
  decodeEntities,
  isFresh,
  login,
  normalizeTokens,
  parseAppRedirect,
  parseForm,
  parseTemplateModel,
  refresh,
} from '../src/vw/auth.js';
import { CookieJar } from '../src/vw/http.js';
import { createFakeVolkswagen } from './helpers/fakeVolkswagen.js';

const credentials = { email: 'driver@example.com', password: 'secret-password' };

for (const loginFlow of ['legacy', 'single']) {
  test(`signs in through the ${loginFlow} login page`, async () => {
    const vw = createFakeVolkswagen({ loginFlow });
    const tokens = await login({ ...credentials, fetch: vw.fetch });
    assert.equal(vw.logins, 1);
    assert.ok(vw.validTokens.has(tokens.accessToken));
    assert.equal(tokens.refreshToken, 'refresh-1');
    assert.ok(tokens.expiresAt > Date.now(), 'the expiry comes from the JWT');
    assert.ok(isFresh(tokens));
  });

  test(`a wrong password on the ${loginFlow} page is an account error`, async () => {
    const vw = createFakeVolkswagen({ loginFlow });
    await assert.rejects(
      login({ ...credentials, password: 'wrong', fetch: vw.fetch }),
      (err) => err instanceof VwAuthError && /password/.test(err.userMessage.en),
    );
    assert.equal(vw.logins, 0);
  });
}

test('an unknown account is an account error', async () => {
  const vw = createFakeVolkswagen();
  await assert.rejects(
    login({ ...credentials, email: 'nobody@example.com', fetch: vw.fetch }),
    VwAuthError,
  );
});

test('terms to accept stop the sign-in with an explicit message', async () => {
  const vw = createFakeVolkswagen({ termsToAccept: true });
  await assert.rejects(
    login({ ...credentials, fetch: vw.fetch }),
    (err) => err instanceof VwAuthError && /terms/.test(err.userMessage.en),
  );
});

test('missing credentials never reach Volkswagen', async () => {
  const vw = createFakeVolkswagen();
  await assert.rejects(login({ email: '', password: '', fetch: vw.fetch }), VwAuthError);
  assert.equal(vw.requests.length, 0);
});

test('a refresh keeps the refresh token when the answer has none', async () => {
  const vw = createFakeVolkswagen();
  const tokens = await login({ ...credentials, fetch: vw.fetch });
  const renewed = await refresh(tokens, { fetch: vw.fetch });
  assert.notEqual(renewed.accessToken, tokens.accessToken);
  assert.equal(renewed.refreshToken, tokens.refreshToken);
  assert.equal(vw.refreshes, 1);
});

test('a refused refresh token is an account error, so the client signs in again', async () => {
  const vw = createFakeVolkswagen();
  const tokens = await login({ ...credentials, fetch: vw.fetch });
  vw.revokeRefreshTokens();
  await assert.rejects(refresh(tokens, { fetch: vw.fetch }), VwAuthError);
});

test('form, script and fragment parsing', () => {
  const form = parseForm(
    '<form id="other"></form><form id="emailPasswordForm" action="/a?x=1&amp;y=2"><input name="hmac" value="h&#39;1"><input name="email"></form>',
    'emailPasswordForm',
  );
  assert.deepEqual(form, { action: '/a?x=1&y=2', data: { hmac: "h'1", email: '' } });
  assert.equal(parseForm('<html></html>', 'emailPasswordForm'), undefined);

  const template = parseTemplateModel(
    '<script>\n  templateModel: {"hmac":"h","postAction":"p"},\n  csrf_token: \'c\',\n</script>',
  );
  assert.deepEqual(template, { model: { hmac: 'h', postAction: 'p' }, csrf: 'c' });

  assert.deepEqual(parseAppRedirect('weconnect://authenticated#state=s&code=c'), {
    state: 's',
    code: 'c',
  });
  assert.equal(decodeEntities('&lt;a&gt; &#x41;'), '<a> A');
});

test('token responses are normalized from camelCase and snake_case', () => {
  const now = 1_000_000;
  assert.deepEqual(
    normalizeTokens({ accessToken: 'a', refreshToken: 'r', idToken: 'i' }, {}, now),
    {
      accessToken: 'a',
      refreshToken: 'r',
      idToken: 'i',
      expiresAt: now + 3600 * 1000,
    },
  );
  assert.equal(
    normalizeTokens({ access_token: 'b', expires_in: 60 }, { refreshToken: 'r' }, now).expiresAt,
    now + 60_000,
  );
  assert.throws(() => normalizeTokens({}), /no access token/);
  assert.equal(isFresh({ accessToken: 'a', expiresAt: now + 30_000 }, now), false);
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

  const expire = new Headers();
  expire.append('set-cookie', 'a=; Max-Age=0');
  jar.store('https://identity.vwgroup.io/x', { headers: expire });
  assert.equal(jar.header('https://identity.vwgroup.io/y'), 'b=2');
});
