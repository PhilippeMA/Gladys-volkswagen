// -----------------------------------------------------------------------------
// Minimal HTTP helpers for the Volkswagen portal: a cookie jar and a session
// that never follows redirects by itself.
//
// The sign-in is a browser flow across identity.vwgroup.io and the EU Data
// Act portal: each hop sets cookies, and the portal session is the cookies
// themselves. So every redirect is followed by hand, the cookies carried from
// hop to hop, and the flow can stop before the portal's heavy landing page.
// -----------------------------------------------------------------------------

import { httpsFetch } from './transport.js';

/**
 * A deliberately small cookie jar: name/value per domain, no path handling
 * (both sites scope their cookies to `/`).
 */
export class CookieJar {
  constructor() {
    this.cookies = new Map(); // `${domain}\t${name}` -> { domain, name, value, hostOnly }
  }

  /** Store the `Set-Cookie` headers of a response received from `url`. */
  store(url, response) {
    const host = new URL(url).hostname;
    const headers = response.headers;
    const setCookies =
      typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : [headers.get('set-cookie')].filter(Boolean);
    for (const raw of setCookies) {
      const [pair, ...attributes] = raw.split(';');
      const separator = pair.indexOf('=');
      if (separator <= 0) {
        continue;
      }
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      let domain = host;
      let hostOnly = true;
      let expired = value === '';
      for (const attribute of attributes) {
        const [key, ...rest] = attribute.split('=');
        const attrName = key.trim().toLowerCase();
        const attrValue = rest.join('=').trim();
        if (attrName === 'domain' && attrValue) {
          domain = attrValue.replace(/^\./, '').toLowerCase();
          hostOnly = false;
        } else if (attrName === 'max-age' && Number(attrValue) <= 0) {
          expired = true;
        }
      }
      const id = `${domain}\t${name}`;
      if (expired) {
        this.cookies.delete(id);
      } else {
        this.cookies.set(id, { domain, name, value, hostOnly });
      }
    }
  }

  #matching(url) {
    const host = new URL(url).hostname;
    return [...this.cookies.values()].filter(({ domain, hostOnly }) =>
      hostOnly ? host === domain : host === domain || host.endsWith(`.${domain}`),
    );
  }

  /** The `Cookie` header to send to `url`, or undefined when none applies. */
  header(url) {
    const pairs = this.#matching(url).map(({ name, value }) => `${name}=${value}`);
    return pairs.length > 0 ? pairs.join('; ') : undefined;
  }

  /** Value of the cookie `name` sent to `url`, or undefined. */
  value(name, url) {
    return this.#matching(url).find((cookie) => cookie.name === name)?.value;
  }
}

/** A cookie-carrying session with manual redirects. */
export class WebSession {
  constructor({ fetch: fetchImpl = httpsFetch, headers = {}, timeoutMs = 60_000 } = {}) {
    this.fetch = fetchImpl;
    this.jar = new CookieJar();
    this.headers = headers;
    this.timeoutMs = timeoutMs;
  }

  /**
   * One request, never following redirects. `form` is sent url-encoded.
   * Resolves the raw response (`status`, `headers`, `text()`...).
   */
  async request(method, url, { form, headers = {} } = {}) {
    const finalHeaders = { ...this.headers, ...headers };
    const cookie = this.jar.header(url);
    if (cookie) {
      finalHeaders.cookie = cookie;
    }
    let body;
    if (form !== undefined) {
      body = new URLSearchParams(form).toString();
      finalHeaders['content-type'] = 'application/x-www-form-urlencoded';
    }
    const response = await this.fetch(url, {
      method,
      headers: finalHeaders,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    this.jar.store(url, response);
    return response;
  }

  /**
   * Follow the redirects from `first` (the response `url` answered) by hand,
   * with GET requests, until a page answers (non-3xx) or `stopBefore(next)`
   * returns true for the next URL — which is then not requested. Resolves
   * `{ url, response, stoppedAt }`: the last URL requested, its response,
   * and the URL the flow stopped before (undefined if it did not stop).
   */
  async follow(url, first, { stopBefore = () => false, rewrite = (next) => next } = {}) {
    let current = url;
    let response = first;
    for (let hop = 0; hop < 20; hop += 1) {
      if (response.status < 300 || response.status >= 400) {
        return { url: current, response };
      }
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`Redirect without Location (${response.status}) from ${hostOf(current)}`);
      }
      const next = rewrite(new URL(location, current).toString());
      if (stopBefore(next)) {
        return { url: current, response, stoppedAt: next };
      }
      current = next;
      response = await this.request('GET', current, { headers: { referer: url } });
    }
    throw new Error('Too many redirects during the Volkswagen sign-in');
  }
}

/** Host of a URL, for log and error messages that must never carry tokens. */
export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown host';
  }
}
