// -----------------------------------------------------------------------------
// Sign-in to the Volkswagen EU Data Act portal.
//
// Volkswagen retired the OAuth client of the ID. app API on 2026-06-01 (its
// sign-in now answers HTTP 403). What remains open to third parties is the
// portal Volkswagen runs for the EU Data Act
// (https://eu-data-act.drivesomethinggreater.com): read-only datasets of the
// car, delivered every 15 minutes, with the same account as the Volkswagen
// app. This flow follows the open-source ioBroker.vw-connect and evcc
// clients:
//   1. the OpenID authorization of the portal's own client on
//      identity.vwgroup.io serves the email form, then the password page;
//   2. after the password, the redirects go back to the portal, whose
//      callback sets the session cookies (`access_token` among them);
//   3. the flow stops before the portal's landing page, which is not needed.
// The session IS the cookie jar: the API calls carry its cookies.
//
// Every URL, client id and header lives here and in src/vw/client.js, so a
// change on Volkswagen's side is fixed in one place.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { WebSession, hostOf } from './http.js';
import { httpsFetch } from './transport.js';

export const PORTAL_URL = 'https://eu-data-act.drivesomethinggreater.com';
export const IDENTITY_URL = 'https://identity.vwgroup.io';

// OpenID client of the portal for Volkswagen passenger cars (the ID. range).
export const CLIENT_ID = '9b58543e-1c15-4193-91d5-8a14145bebb0@apps_vw-dilab_com';
const BRAND = 'VOLKSWAGEN_PASSENGER_CARS';
const AUTHORIZE_URL = `${IDENTITY_URL}/oidc/v1/authorize`;
const REDIRECT_URI = `${PORTAL_URL}/login`;
const SCOPE = 'openid cars profile';

export const USER_AGENT = 'Gladys-Volkswagen (+https://github.com/PhilippeMA/Gladys-volkswagen)';

const WEB_HEADERS = {
  'user-agent': USER_AGENT,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

/**
 * The account cannot sign in: wrong credentials, portal consent missing,
 * locked account... Retrying will not help until the user acts, unlike a
 * network failure. `userMessage` is the multi-language text shown in Gladys.
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

export const MESSAGES = {
  missingCredentials: {
    en: 'Enter the email address and the password of your Volkswagen account.',
    fr: 'Renseignez l’adresse e-mail et le mot de passe de votre compte Volkswagen.',
  },
  badCredentials: {
    en: 'Volkswagen sign-in refused: check the email address and the password.',
    fr: 'Connexion Volkswagen refusée : vérifiez l’adresse e-mail et le mot de passe.',
  },
  portalConsent: {
    en: 'Sign in once to the Volkswagen EU Data Act portal in a browser and accept its terms (see the documentation).',
    fr: 'Connectez-vous une fois au portail EU Data Act de Volkswagen dans un navigateur et acceptez ses conditions (voir la documentation).',
  },
  throttled: {
    en: 'Too many sign-in attempts: Volkswagen blocks the account for a while.',
    fr: 'Trop de tentatives de connexion : Volkswagen bloque le compte pour un moment.',
  },
  locked: {
    en: 'The Volkswagen account is locked or disabled.',
    fr: 'Le compte Volkswagen est verrouillé ou désactivé.',
  },
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
 * The `action` and the `<input>` values of the form whose id is `formId`
 * (the first form when `formId` is omitted), or undefined.
 */
export function parseForm(html, formId) {
  for (const [formHtml] of html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)) {
    const openTag = formHtml.match(/<form\b[^>]*>/i)[0];
    if (formId !== undefined && attribute(openTag, 'id') !== formId) {
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
 * The identity pages carry their form state in a script object,
 * `templateModel: {...}`, plus `csrf_token: '...'`. The object is read by
 * brace matching: it holds nested objects.
 */
export function parseTemplateModel(html) {
  const index = html.indexOf('templateModel');
  const start = index < 0 ? -1 : html.indexOf('{', index);
  if (start < 0) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  for (let i = start; i < html.length; i += 1) {
    const char = html[i];
    if (inString) {
      if (char === '\\') i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const model = JSON.parse(html.slice(start, i + 1));
          const csrf = html.match(/csrf_token\s*[:=]\s*['"]([^'"]+)['"]/);
          return { model, csrf: csrf ? csrf[1] : undefined };
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

// --- Landing pages ------------------------------------------------------------

/** The portal page the sign-in ends on (`/<country>/<language>/user.html`). */
export function isPortalLandingPage(url) {
  const target = new URL(url);
  return (
    target.origin === PORTAL_URL &&
    /^\/(?:content\/euda\/)?[a-z]{2}\/[a-z]{2}\/user\.html$/.test(target.pathname)
  );
}

/**
 * Volkswagen sometimes shows an OPTIONAL marketing-consent page after a
 * successful sign-in. Its URL embeds the callback that completes the sign-in
 * without consenting: resolve it, or undefined for any other URL. Only a
 * callback on the identity provider itself is accepted.
 */
export function marketingConsentCallback(url) {
  const page = new URL(url);
  if (page.origin !== IDENTITY_URL || !/\/consent\/marketing\//i.test(page.pathname)) {
    return undefined;
  }
  const callback = page.searchParams.get('callback');
  if (!callback || !URL.canParse(callback)) {
    return undefined;
  }
  const target = new URL(callback);
  const validPath =
    target.pathname === '/oidc/v1/oauth/client/callback' ||
    target.pathname === '/oidc/v1/oauth/client/callback/success';
  if (target.origin !== IDENTITY_URL || !validPath) {
    return undefined;
  }
  target.search = target.searchParams.toString();
  return target.toString();
}

/** The account-side reason of a sign-in that ended back on the identity pages. */
function failureFrom(url, html = '') {
  const page = new URL(url);
  const code = page.searchParams.get('error') ?? parseTemplateModel(html)?.model?.error ?? '';
  const text = typeof code === 'string' ? code : JSON.stringify(code);
  if (/password_invalid|email_invalid|identifier|user_id/i.test(text)) {
    return new VwAuthError(text, MESSAGES.badCredentials);
  }
  if (/throttle|rate_limit|too_many/i.test(text)) {
    return new VwAuthError(text, MESSAGES.throttled);
  }
  if (/account_disabled|locked|blocked/i.test(text)) {
    return new VwAuthError(text, MESSAGES.locked);
  }
  return new VwAuthError(text || `sign-in stopped on ${page.pathname}`, MESSAGES.portalConsent);
}

// --- Sign-in --------------------------------------------------------------------

/**
 * Run the complete sign-in with the account email and password. Resolves the
 * WebSession holding the portal cookies. Throws VwAuthError when the account
 * itself is refused.
 */
export async function login({ email, password, fetch: fetchImpl = httpsFetch, logger }) {
  if (!email || !password) {
    throw new VwAuthError('missing credentials', MESSAGES.missingCredentials);
  }
  const web = new WebSession({ fetch: fetchImpl, headers: WEB_HEADERS });

  // 1. The OpenID authorization of the portal's client: the email page.
  const authorize = new URL(AUTHORIZE_URL);
  authorize.search = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    scope: SCOPE,
    state: `de__en__${BRAND}`,
    redirect_uri: REDIRECT_URI,
    prompt: 'login',
    nonce: randomBytes(24).toString('base64url'),
  }).toString();
  const first = await web.request('GET', authorize.toString());
  const emailPage = await web.follow(authorize.toString(), first);
  if (emailPage.response.status !== 200) {
    throw new Error(
      `Volkswagen sign-in page unavailable (HTTP ${emailPage.response.status}, ${hostOf(emailPage.url)})`,
    );
  }
  const emailHtml = await emailPage.response.text();
  const emailForm = parseForm(emailHtml, 'emailPasswordForm') ?? parseForm(emailHtml);
  const emailTemplate = parseTemplateModel(emailHtml);
  const emailFields = {
    ...(emailForm?.data ?? {}),
    ...pick(emailTemplate?.model, ['hmac', 'relayState']),
  };
  if (emailTemplate?.csrf && !emailFields._csrf) {
    emailFields._csrf = emailTemplate.csrf;
  }
  if (!emailForm?.action || !emailFields.hmac || !emailFields._csrf) {
    throw new Error('Volkswagen sign-in page not recognized (the layout may have changed)');
  }

  // 2. The email, then the password page.
  const identifierUrl = new URL(emailForm.action, emailPage.url).toString();
  const afterEmail = await web.request('POST', identifierUrl, {
    form: { ...emailFields, email },
    headers: { referer: emailPage.url },
  });
  const passwordPage = await web.follow(identifierUrl, afterEmail);
  const passwordHtml = await passwordPage.response.text();
  const template = parseTemplateModel(passwordHtml);
  const model = template?.model ?? {};
  if (passwordPage.response.status >= 400 || model.error || model.errorCode) {
    throw failureFrom(passwordPage.url, passwordHtml);
  }
  if (model.registerCredentialsPath === 'register') {
    throw new VwAuthError('unknown account', MESSAGES.badCredentials);
  }
  if (!model.hmac || !model.relayState) {
    throw new Error('Volkswagen password page not recognized (the layout may have changed)');
  }
  // The password goes where the email went, `identifierUrl` -> `postAction`.
  const passwordForm = parseForm(passwordHtml);
  const authenticateUrl =
    model.identifierUrl && model.postAction && identifierUrl.includes(model.identifierUrl)
      ? identifierUrl.replace(model.identifierUrl, model.postAction)
      : new URL(
          passwordForm?.action ?? passwordPage.url.split('?')[0],
          passwordPage.url,
        ).toString();

  // 3. The password; the redirects lead back to the portal, which sets the
  // session cookies. Stop before its landing page, skip the optional
  // marketing consent through its own callback.
  const afterPassword = await web.request('POST', authenticateUrl, {
    form: {
      _csrf: template.csrf ?? passwordForm?.data?._csrf ?? '',
      relayState: model.relayState,
      hmac: model.hmac,
      email,
      password,
    },
    headers: { referer: passwordPage.url },
  });
  const landing = await web.follow(authenticateUrl, afterPassword, {
    stopBefore: isPortalLandingPage,
    rewrite: (next) => marketingConsentCallback(next) ?? next,
  });

  const end = new URL(landing.stoppedAt ?? landing.url);
  if (end.origin !== PORTAL_URL) {
    const html = landing.stoppedAt ? '' : await landing.response.text();
    throw failureFrom(end.toString(), html);
  }
  if (!landing.stoppedAt && landing.response.status >= 400) {
    throw new Error(`The Volkswagen portal refused the sign-in (HTTP ${landing.response.status})`);
  }
  if (!web.jar.value('access_token', `${PORTAL_URL}/proxy_api/`)) {
    throw new VwAuthError('no portal session', MESSAGES.portalConsent);
  }
  logger?.info('Signed in to the Volkswagen EU Data Act portal');
  return web;
}

function pick(object, keys) {
  const picked = {};
  for (const key of keys) {
    if (object?.[key]) {
      picked[key] = object[key];
    }
  }
  return picked;
}
