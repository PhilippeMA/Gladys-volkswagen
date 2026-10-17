// -----------------------------------------------------------------------------
// Volkswagen ID sign-in (the account of the "Volkswagen" smartphone app).
//
// Volkswagen publishes no API for third parties: this is the flow the official
// Android app runs, as documented by the open-source WeConnect / CarConnectivity
// projects. In short:
//   1. the CARIAD backend hands out an OpenID authorization URL;
//   2. the identity provider (identity.vwgroup.io) serves a login page — the
//      legacy two-step email/password form, or the newer single form — and,
//      once signed in, redirects to `weconnect://authenticated#...` with the
//      OpenID tokens in the fragment;
//   3. the CARIAD backend swaps them for its own access/refresh tokens.
// Refreshing then goes straight to the CARIAD token endpoint.
//
// Every URL, client id and header lives here, so a change on Volkswagen's
// side is fixed in one place.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { WebSession, hostOf, isAppRedirect, resolveLocation } from './http.js';

export const CLIENT_ID = 'a24fba63-34b3-4d43-b181-942111e6bda8@apps_vw-dilab_com';
export const REDIRECT_URI = 'weconnect://authenticated';
export const BFF_URL = 'https://emea.bff.cariad.digital';
export const IDENTITY_URL = 'https://identity.vwgroup.io';

const AUTHORIZE_URL = `${BFF_URL}/user-login/v1/authorize`;
const LOGIN_TOKEN_URL = `${BFF_URL}/user-login/login/v1`;
const REFRESH_TOKEN_URL = `${BFF_URL}/login/v1/idk/token`;

export const APP_USER_AGENT = 'Volkswagen/3.51.1-android/14';
const APP_PACKAGE = 'com.volkswagen.weconnect';

const WEB_HEADERS = {
  'user-agent': APP_USER_AGENT,
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3',
  'accept-language': 'en-US,en;q=0.9',
  'x-requested-with': APP_PACKAGE,
  'x-android-package-name': APP_PACKAGE,
  'upgrade-insecure-requests': '1',
};

// Refresh a little before the expiry, so a request never leaves with a token
// that dies on its way.
const EXPIRY_MARGIN_MS = 60_000;
// When neither the response nor the JWT says how long a token lives.
const DEFAULT_TOKEN_LIFETIME_S = 3600;

/**
 * The account cannot sign in: wrong credentials, terms to accept, locked
 * account... Retrying will not help until the user acts, unlike a network
 * failure. `userMessage` is the multi-language text shown in Gladys.
 */
export class VwAuthError extends Error {
  constructor(message, userMessage) {
    super(message);
    this.name = 'VwAuthError';
    this.userMessage = userMessage ?? {
      en: `Volkswagen sign-in failed: ${message}`,
      fr: `Échec de la connexion Volkswagen : ${message}`,
    };
  }
}

const BAD_CREDENTIALS = {
  en: 'Volkswagen sign-in refused: check the email address and the password.',
  fr: 'Connexion Volkswagen refusée : vérifiez l’adresse e-mail et le mot de passe.',
};
const TERMS_TO_ACCEPT = {
  en: 'Volkswagen asks you to accept new terms: open the Volkswagen app, sign in and accept them.',
  fr: 'Volkswagen demande d’accepter de nouvelles conditions : ouvrez l’application Volkswagen, connectez-vous et acceptez-les.',
};
const THROTTLED = {
  en: 'Too many sign-in attempts: Volkswagen blocks the account for a few minutes.',
  fr: 'Trop de tentatives de connexion : Volkswagen bloque le compte quelques minutes.',
};

// --- HTML parsing (no dependency: the pages are small and stable enough) -----

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'" };

export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const key = entity.toLowerCase();
    if (ENTITIES[key] !== undefined) {
      return ENTITIES[key];
    }
    if (key.startsWith('#x')) {
      return String.fromCodePoint(parseInt(key.slice(2), 16));
    }
    if (key.startsWith('#')) {
      return String.fromCodePoint(parseInt(key.slice(1), 10));
    }
    return match;
  });
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  if (!match) {
    return undefined;
  }
  return decodeEntities(match[2] ?? match[3]);
}

/**
 * The `action` and the `<input>` values of the form whose id is `formId`,
 * or undefined when the page has no such form.
 */
export function parseForm(html, formId) {
  const forms = html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi);
  for (const [formHtml] of forms) {
    const openTag = formHtml.match(/<form\b[^>]*>/i)[0];
    if (attribute(openTag, 'id') !== formId) {
      continue;
    }
    const data = {};
    for (const [input] of formHtml.matchAll(/<input\b[^>]*>/gi)) {
      const name = attribute(input, 'name');
      if (name) {
        data[name] = attribute(input, 'value') ?? '';
      }
    }
    return { action: attribute(openTag, 'action'), data };
  }
  return undefined;
}

/**
 * The legacy password page carries its form as a script object:
 * `templateModel: {...},` plus `csrf_token: '...'`.
 */
export function parseTemplateModel(html) {
  const match = html.match(/templateModel:\s*(\{.*?\}),\s*\n/);
  if (!match) {
    return undefined;
  }
  const model = JSON.parse(match[1]);
  const csrf = html.match(/csrf_token:\s*'([^']*)'/);
  return { model, csrf: csrf ? csrf[1] : undefined };
}

/** `state` hidden input of the newer single-form login page. */
export function parseLoginState(html) {
  for (const [input] of html.matchAll(/<input\b[^>]*>/gi)) {
    if (attribute(input, 'name') === 'state') {
      return attribute(input, 'value');
    }
  }
  return undefined;
}

/** The parameters of the `weconnect://authenticated#a=b&c=d` fragment. */
export function parseAppRedirect(url) {
  const hashIndex = url.indexOf('#');
  const queryIndex = url.indexOf('?');
  const index = hashIndex >= 0 ? hashIndex : queryIndex;
  return Object.fromEntries(new URLSearchParams(index >= 0 ? url.slice(index + 1) : ''));
}

// --- Tokens -------------------------------------------------------------------

/** Expiry (ms since epoch) of a JWT, from its `exp` claim, or undefined. */
export function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalize a token response of the CARIAD backend: it answers camelCase on
 * login (`accessToken`) and snake_case on refresh (`access_token`).
 */
export function normalizeTokens(body, previous = {}, now = Date.now()) {
  const accessToken = body.accessToken ?? body.access_token;
  if (!accessToken) {
    throw new Error('The Volkswagen token response carries no access token');
  }
  const refreshToken = body.refreshToken ?? body.refresh_token ?? previous.refreshToken;
  const idToken = body.idToken ?? body.id_token ?? previous.idToken;
  const expiresIn = Number(body.expiresIn ?? body.expires_in);
  const expiresAt = Number.isFinite(expiresIn)
    ? now + expiresIn * 1000
    : (jwtExpiry(accessToken) ?? now + DEFAULT_TOKEN_LIFETIME_S * 1000);
  return { accessToken, refreshToken, idToken, expiresAt };
}

export function isFresh(tokens, now = Date.now()) {
  return Boolean(tokens?.accessToken) && tokens.expiresAt - EXPIRY_MARGIN_MS > now;
}

// --- Sign-in --------------------------------------------------------------------

/**
 * Run the complete sign-in with the account email and password. Resolves the
 * normalized tokens. Throws VwAuthError when the account itself is refused.
 */
export async function login({ email, password, fetch: fetchImpl = globalThis.fetch, logger }) {
  if (!email || !password) {
    throw new VwAuthError('missing credentials', {
      en: 'Enter the email address and the password of your Volkswagen account.',
      fr: 'Renseignez l’adresse e-mail et le mot de passe de votre compte Volkswagen.',
    });
  }
  const web = new WebSession({ fetch: fetchImpl, headers: WEB_HEADERS });

  // 1. The backend builds the OpenID authorization URL (303 to the identity provider).
  const nonce = randomBytes(16).toString('hex');
  const start = new URL(AUTHORIZE_URL);
  start.searchParams.set('redirect_uri', REDIRECT_URI);
  start.searchParams.set('nonce', nonce);
  const startResponse = await web.request('GET', start.toString());
  const authorizeLocation = startResponse.headers.get('location');
  if (startResponse.status < 300 || startResponse.status >= 400 || !authorizeLocation) {
    throw new Error(`Volkswagen authorization URL unavailable (HTTP ${startResponse.status})`);
  }

  // 2. Reach the login page.
  const page = await web.follow(resolveLocation(authorizeLocation, start.toString()));
  let appRedirect;
  if (isAppRedirect(page.url)) {
    appRedirect = page.url;
  } else {
    if (page.response.status >= 400) {
      throw new Error(`Volkswagen login page unavailable (HTTP ${page.response.status})`);
    }
    const html = await page.response.text();
    const emailForm = parseForm(html, 'emailPasswordForm');
    const afterLogin = emailForm
      ? await legacyLogin(web, { email, password, emailForm, logger })
      : await singleFormLogin(web, { email, password, html, logger });
    appRedirect = await followToApp(web, afterLogin);
  }

  // 3. Swap the OpenID tokens for the backend's own.
  const params = parseAppRedirect(appRedirect);
  for (const key of ['state', 'id_token', 'access_token', 'code']) {
    if (!params[key]) {
      throw new Error(`The Volkswagen sign-in ended without "${key}"`);
    }
  }
  const tokenResponse = await web.request('POST', LOGIN_TOKEN_URL, {
    headers: { accept: 'application/json', 'content-version': '1' },
    json: {
      state: params.state,
      id_token: params.id_token,
      redirect_uri: REDIRECT_URI,
      region: 'emea',
      access_token: params.access_token,
      authorizationCode: params.code,
    },
  });
  if (tokenResponse.status !== 200) {
    throw new Error(`Volkswagen token exchange failed (HTTP ${tokenResponse.status})`);
  }
  logger?.info('Signed in to the Volkswagen account');
  return normalizeTokens(await tokenResponse.json());
}

/** The historical two-step form: email first, then password. */
async function legacyLogin(web, { email, password, emailForm }) {
  const emailUrl = new URL(emailForm.action, IDENTITY_URL).toString();
  const emailResponse = await web.request('POST', emailUrl, {
    form: { ...emailForm.data, email },
  });
  const passwordPage = await web.follow(emailUrl, { first: emailResponse });
  if (!passwordPage.response || passwordPage.response.status !== 200) {
    throw new Error('Volkswagen password page unavailable');
  }
  const template = parseTemplateModel(await passwordPage.response.text());
  if (!template) {
    throw new Error('Volkswagen password page not recognized');
  }
  const { model, csrf } = template;
  if (model.error || model.errorCode) {
    throw new VwAuthError(`login error ${model.error ?? model.errorCode}`, BAD_CREDENTIALS);
  }
  if (model.registerCredentialsPath === 'register') {
    throw new VwAuthError('unknown account', BAD_CREDENTIALS);
  }
  if (!model.postAction || !model.hmac || !model.relayState) {
    throw new Error('Volkswagen password page incomplete');
  }
  const authenticateUrl = `${IDENTITY_URL}/signin-service/v1/${CLIENT_ID}/${model.postAction}`;
  const response = await web.request('POST', authenticateUrl, {
    form: {
      _csrf: csrf ?? '',
      relayState: model.relayState,
      hmac: model.hmac,
      email,
      password,
    },
  });
  const location = response.headers.get('location');
  if (response.status < 300 || response.status >= 400 || !location) {
    throw new Error(`Volkswagen sign-in answered HTTP ${response.status}`);
  }
  const next = resolveLocation(location, authenticateUrl);
  if (!isAppRedirect(next)) {
    const error = new URL(next).searchParams.get('error');
    if (error === 'login.error.throttled') {
      throw new VwAuthError('throttled', THROTTLED);
    }
    if (error) {
      throw new VwAuthError(error, BAD_CREDENTIALS);
    }
    if (new URL(next).searchParams.get('updated') === 'dataprivacy') {
      throw new VwAuthError('terms to accept', TERMS_TO_ACCEPT);
    }
  }
  return next;
}

/** The newer single form (`/u/login?state=...`): username + password at once. */
async function singleFormLogin(web, { email, password, html }) {
  const state = parseLoginState(html);
  if (!state) {
    throw new Error('Volkswagen login page not recognized');
  }
  const loginUrl = `${IDENTITY_URL}/u/login?state=${encodeURIComponent(state)}`;
  const response = await web.request('POST', loginUrl, {
    form: { username: email, password, state },
  });
  const location = response.headers.get('location');
  if (response.status < 300 || response.status >= 400 || !location) {
    // The page is served again (HTTP 400) when the credentials are wrong.
    if (response.status === 400 || response.status === 401 || response.status === 200) {
      throw new VwAuthError(`login refused (HTTP ${response.status})`, BAD_CREDENTIALS);
    }
    throw new Error(`Volkswagen sign-in answered HTTP ${response.status}`);
  }
  return resolveLocation(location, loginUrl);
}

/** Follow the post-login redirects to `weconnect://authenticated#...`. */
async function followToApp(web, url) {
  let current = url;
  for (let hop = 0; hop < 15; hop += 1) {
    if (isAppRedirect(current)) {
      return current;
    }
    if (current.includes('terms-and-conditions') || current.includes('/consent')) {
      throw new VwAuthError('terms to accept', TERMS_TO_ACCEPT);
    }
    const response = await web.request('GET', current);
    const location = response.headers.get('location');
    if (!location) {
      throw new Error(
        `Volkswagen sign-in stopped on ${hostOf(current)} (HTTP ${response.status}); ` +
          'sign in once in the Volkswagen app to check the account',
      );
    }
    current = resolveLocation(location, current);
  }
  throw new Error('Too many redirects after the Volkswagen sign-in');
}

/**
 * Refresh the backend tokens. Resolves the new normalized tokens (the refresh
 * token is kept when the response carries none). Throws VwAuthError when the
 * refresh token is refused, so the caller signs in again.
 */
export async function refresh(tokens, { fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!tokens?.refreshToken) {
    throw new VwAuthError('no refresh token');
  }
  const response = await fetchImpl(REFRESH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': APP_USER_AGENT,
      'x-android-package-name': APP_PACKAGE,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw new VwAuthError(`refresh refused (HTTP ${response.status})`);
  }
  if (response.status !== 200) {
    throw new Error(`Volkswagen token refresh failed (HTTP ${response.status})`);
  }
  return normalizeTokens(await response.json(), tokens);
}
