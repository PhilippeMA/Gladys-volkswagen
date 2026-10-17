// -----------------------------------------------------------------------------
// Minimal HTTP helpers for the Volkswagen sign-in: a cookie jar and a fetch
// wrapper that never follows redirects by itself.
//
// The identity provider (identity.vwgroup.io) is a browser flow: it sets
// session cookies on every hop and ends on a `weconnect://` custom-scheme
// redirect that no HTTP client can follow. So every redirect is followed by
// hand, the cookies carried from hop to hop.
// -----------------------------------------------------------------------------

/**
 * A deliberately small cookie jar: name/value per domain, no path or expiry
 * handling (the sign-in lasts a few seconds and is thrown away afterwards).
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
      let expired = false;
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

  /** The `Cookie` header to send to `url`, or undefined when none applies. */
  header(url) {
    const host = new URL(url).hostname;
    const pairs = [];
    for (const { domain, name, value, hostOnly } of this.cookies.values()) {
      const matches = hostOnly ? host === domain : host === domain || host.endsWith(`.${domain}`);
      if (matches) {
        pairs.push(`${name}=${value}`);
      }
    }
    return pairs.length > 0 ? pairs.join('; ') : undefined;
  }
}

/** True for the custom-scheme URL the sign-in ends on (never fetchable). */
export function isAppRedirect(url) {
  return typeof url === 'string' && url.startsWith('weconnect://');
}

/**
 * Resolve a `Location` header against the URL that answered it. The custom
 * scheme is kept as is (`new URL` would mangle nothing, but stay explicit).
 */
export function resolveLocation(location, base) {
  if (isAppRedirect(location)) {
    return location;
  }
  return new URL(location, base).toString();
}

/**
 * A browser-like session: one cookie jar, manual redirects, the default
 * headers of the Volkswagen Android app web view.
 */
export class WebSession {
  constructor({ fetch: fetchImpl = globalThis.fetch, headers = {}, timeoutMs = 30_000 } = {}) {
    this.fetch = fetchImpl;
    this.jar = new CookieJar();
    this.headers = headers;
    this.timeoutMs = timeoutMs;
  }

  /**
   * One request, never following redirects. `form` is sent url-encoded,
   * `json` as JSON. Resolves the raw Response (status, headers, body).
   */
  async request(method, url, { form, json, headers = {} } = {}) {
    const finalHeaders = { ...this.headers, ...headers };
    const cookie = this.jar.header(url);
    if (cookie) {
      finalHeaders.cookie = cookie;
    }
    let body;
    if (form !== undefined) {
      body = new URLSearchParams(form).toString();
      finalHeaders['content-type'] = 'application/x-www-form-urlencoded';
    } else if (json !== undefined) {
      body = JSON.stringify(json);
      finalHeaders['content-type'] = 'application/json';
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
   * Follow the redirects from `url` by hand, until a page answers (2xx) or
   * the sign-in hands over to the app (`weconnect://`). Resolves
   * `{ url, response }`, `response` being undefined in the app case.
   */
  async follow(url, { maxRedirects = 15, first } = {}) {
    let current = url;
    let response = first;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (isAppRedirect(current)) {
        return { url: current, response: undefined };
      }
      if (!response) {
        response = await this.request('GET', current);
      }
      if (response.status < 300 || response.status >= 400) {
        return { url: current, response };
      }
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`Redirect without Location (${response.status}) from ${hostOf(current)}`);
      }
      current = resolveLocation(location, current);
      response = undefined;
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
