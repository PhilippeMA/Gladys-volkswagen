// -----------------------------------------------------------------------------
// HTTPS transport with a `fetch`-like interface, built on node:https.
//
// Why not the global `fetch`: Node's fetch (undici) adds headers of its own to
// every request (`sec-fetch-mode: cors`, `accept-language: *`...). The
// Volkswagen front door rejects requests that do not look like its Android
// app (HTTP 403 on the very first sign-in call), so this transport sends
// exactly the headers the caller gives, like the reference Python clients.
//
// Only what the client uses is implemented: `status`, `headers` (a standard
// Headers object, so `getSetCookie()` works), `text()` and `json()`. No
// redirect is ever followed: callers follow them by hand.
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

function decode(buffer, encoding) {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return zlib.gunzipSync(buffer);
    case 'deflate':
      return zlib.inflateSync(buffer);
    case 'br':
      return zlib.brotliDecompressSync(buffer);
    default:
      return buffer;
  }
}

/** Headers object from the raw `[name, value, name, value...]` list. */
function toHeaders(rawHeaders) {
  const headers = new Headers();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    try {
      headers.append(rawHeaders[i], rawHeaders[i + 1]);
    } catch {
      // A header value Headers refuses (non-ASCII...): not one we read.
    }
  }
  return headers;
}

/**
 * `fetch(url, { method, headers, body, signal })` over node:https.
 * Resolves `{ status, headers, text(), json() }`.
 */
export function httpsFetch(url, { method = 'GET', headers = {}, body, signal } = {}) {
  const target = new URL(url);
  const payload = body === undefined || body === null ? undefined : Buffer.from(String(body));
  const requestHeaders = { 'accept-encoding': 'gzip, deflate', ...headers };
  if (payload) {
    requestHeaders['content-length'] = String(payload.length);
  }
  return new Promise((resolve, reject) => {
    // Plain http only serves the tests (a local server); Volkswagen is https.
    const client = target.protocol === 'http:' ? http : https;
    const request = client.request(
      target,
      { method, headers: requestHeaders, signal },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          let content;
          try {
            content = decode(Buffer.concat(chunks), response.headers['content-encoding']);
          } catch (err) {
            reject(new Error(`Undecodable answer from ${target.host}: ${err.message}`));
            return;
          }
          const text = content.toString('utf8');
          resolve({
            status: response.statusCode,
            headers: toHeaders(response.rawHeaders),
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}
