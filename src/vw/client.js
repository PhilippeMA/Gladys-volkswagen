// -----------------------------------------------------------------------------
// Volkswagen EU Data Act portal client.
//
// The portal does not answer live questions: once the user enabled a
// "continuous data request" in a browser (see docs/), the car's data is
// stored as one dataset — a ZIP holding a JSON list of data points — every
// 15 minutes. Reading the car means listing the datasets and downloading the
// new ones. The client owns the portal session: it signs in on first use,
// signs in again once when the portal answers 401/403 (or its HTML error
// page, how the portal reports an expired session), and spaces out refused
// sign-ins.
//
// `fetch` is injectable: the tests run the whole client against an in-memory
// Volkswagen, never the network.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { PORTAL_URL, VwAuthError, login } from './auth.js';
import { httpsFetch } from './transport.js';
import { readJsonFromZip } from './zip.js';

const logger = createLogger({ name: 'vw-portal' });

// After a refused sign-in, wait before trying again: every failed attempt
// counts towards the account lock-out on Volkswagen's side.
const AUTH_RETRY_DELAY_MS = 15 * 60 * 1000;

// Placeholder datasets the portal stores while the car sleeps.
const NO_CONTENT_SUFFIX = '_no_content_found.zip';

/** A non-2xx answer of the portal API. `status` is the HTTP status. */
export class VwApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'VwApiError';
    this.status = status;
  }
}

/** The vehicle has no continuous data request on the portal yet. */
export class NoDataRequestError extends Error {
  constructor(vin) {
    super(`No data request configured on the EU Data Act portal for ${vin.slice(-6)}`);
    this.name = 'NoDataRequestError';
  }
}

/** True when the portal reports an expired session (401/403, or its HTML error page). */
function sessionExpired(status, body) {
  return status === 401 || status === 403 || (status >= 500 && body.trimStart().startsWith('<'));
}

export class VwClient {
  constructor({ email, password, fetch: fetchImpl = httpsFetch, now = () => Date.now() }) {
    this.email = email;
    this.password = password;
    this.fetch = fetchImpl;
    this.now = now;
    this.session = undefined;
    this.pendingLogin = undefined;
    this.authFailure = undefined; // { error, until }
  }

  // --- Session ----------------------------------------------------------------

  /** The signed-in session; concurrent callers share one sign-in. */
  async #session({ renew = false, stale } = {}) {
    if (this.pendingLogin) {
      return this.pendingLogin;
    }
    // A renewal asked with a session another call already renewed reuses it.
    if (this.session && (!renew || this.session !== stale)) {
      return this.session;
    }
    this.pendingLogin = this.#login().finally(() => {
      this.pendingLogin = undefined;
    });
    return this.pendingLogin;
  }

  async #login() {
    if (this.authFailure && this.authFailure.until > this.now()) {
      throw this.authFailure.error;
    }
    try {
      this.session = await login({
        email: this.email,
        password: this.password,
        fetch: this.fetch,
        logger,
      });
      this.authFailure = undefined;
      return this.session;
    } catch (err) {
      this.session = undefined;
      if (err instanceof VwAuthError) {
        this.authFailure = { error: err, until: this.now() + AUTH_RETRY_DELAY_MS };
      }
      throw err;
    }
  }

  // --- Requests -----------------------------------------------------------------

  /**
   * One GET on the portal API (a path) or an absolute https URL, with the
   * session cookies — the jar only sends them to their own sites. Resolves
   * `{ status, response, body }`; `binary` keeps the body as a Buffer.
   */
  async #get(path, headers = {}, { binary = false } = {}) {
    const url = path.startsWith('https://') ? path : `${PORTAL_URL}${path}`;
    let session = await this.#session();
    let answer = await this.#send(session, url, headers, binary);
    if (sessionExpired(answer.status, answer.text)) {
      session = await this.#session({ renew: true, stale: session });
      answer = await this.#send(session, url, headers, binary);
    }
    return answer;
  }

  async #send(session, url, headers, binary) {
    const response = await session.request('GET', url, {
      headers: { accept: binary ? '*/*' : 'application/json', ...headers },
    });
    if (binary && response.status === 200) {
      const body = Buffer.from(await response.arrayBuffer());
      return { status: response.status, body, text: body.subarray(0, 1).toString() };
    }
    const text = await response.text();
    return { status: response.status, body: text, text };
  }

  #fail(what, { status, text }) {
    return new VwApiError(
      `${what} answered HTTP ${status}${text ? `: ${text.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`,
      status,
    );
  }

  #json(what, answer) {
    try {
      return JSON.parse(answer.text);
    } catch {
      throw this.#fail(`${what} (invalid JSON)`, answer);
    }
  }

  // --- Portal API ---------------------------------------------------------------

  /**
   * The cars linked to the portal: `[{ vin, nickname, model, image }]`.
   * `image` is the location of the portal's picture of THIS car (its model,
   * its colour), seen from the front left as `viewPosition` asks.
   */
  async getVehicles() {
    const answer = await this.#get('/proxy_api/consent/me/vehicles?viewPosition=FRONT_LEFT');
    if (answer.status !== 200) {
      throw this.#fail('The vehicle list', answer);
    }
    const payload = this.#json('The vehicle list', answer);
    const list = Array.isArray(payload) ? payload : (payload?.vehicles ?? []);
    const vehicles = new Map();
    for (const entry of list) {
      const vin = entry?.vin ?? entry?.vehicleIdentificationNumber;
      if (typeof vin !== 'string' || vin.length !== 17 || vehicles.has(vin)) {
        continue;
      }
      vehicles.set(vin, {
        vin,
        nickname: entry.nickName ?? entry.vehicleNickname ?? entry.nickname ?? undefined,
        model: entry.modelName ?? undefined,
        image: typeof entry.imageLocation === 'string' ? entry.imageLocation : undefined,
      });
    }
    return [...vehicles.values()];
  }

  /**
   * The picture of a car, from the `image` location of getVehicles (an
   * absolute https URL or a portal path). Resolves `{ body }` (a Buffer).
   */
  async getVehicleImage(location) {
    const url = new URL(location, PORTAL_URL);
    if (url.protocol !== 'https:') {
      throw new VwApiError('The vehicle picture is not served over https', 0);
    }
    const answer = await this.#get(url.toString(), { accept: 'image/*' }, { binary: true });
    if (answer.status !== 200) {
      throw this.#fail('The vehicle picture', answer);
    }
    return { body: answer.body };
  }

  /** Identifier of the car's continuous data request; NoDataRequestError if none. */
  async getDataRequest(vin) {
    const answer = await this.#get(
      `/proxy_api/euda-apim/datarequest/vehicles/${encodeURIComponent(vin)}/metadata/partial`,
    );
    if (answer.status === 404) {
      throw new NoDataRequestError(vin);
    }
    if (answer.status !== 200) {
      throw this.#fail('The data request', answer);
    }
    const identifier = this.#json('The data request', answer)?.Identifier;
    if (!identifier) {
      throw new NoDataRequestError(vin);
    }
    return identifier;
  }

  /**
   * The datasets of a data request with content, oldest first:
   * `[{ name, createdOn }]` (`createdOn` in ms). The "no content" placeholders
   * of a sleeping car are left out.
   */
  async listDatasets(vin, identifier) {
    const answer = await this.#get(
      `/proxy_api/euda-apim/datadelivery/vehicles/${encodeURIComponent(vin)}/${encodeURIComponent(identifier)}/list`,
      { type: 'partial' },
    );
    // 404 "No files available" until the car delivered its first dataset.
    if (answer.status === 404) {
      return [];
    }
    if (answer.status !== 200) {
      throw this.#fail('The dataset list', answer);
    }
    const payload = this.#json('The dataset list', answer);
    const files = Array.isArray(payload) ? payload : (payload?.files ?? []);
    return files
      .filter((file) => typeof file?.name === 'string')
      .filter((file) => !file.name.toLowerCase().endsWith(NO_CONTENT_SUFFIX))
      .map((file) => ({ name: file.name, createdOn: Date.parse(file.createdOn) || 0 }))
      .sort((a, b) => a.createdOn - b.createdOn);
  }

  /** One dataset, unzipped: `{ vin, Data: [{ key, dataFieldName, value, timestampUtc }] }`. */
  async downloadDataset(vin, identifier, name) {
    const answer = await this.#get(
      `/proxy_api/euda-apim/datadelivery/vehicles/${encodeURIComponent(vin)}/${encodeURIComponent(identifier)}/download`,
      { filename: name, type: 'partial' },
      { binary: true },
    );
    if (answer.status !== 200) {
      throw this.#fail('The dataset download', answer);
    }
    return readJsonFromZip(answer.body);
  }
}
