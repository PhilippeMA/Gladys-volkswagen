// -----------------------------------------------------------------------------
// Volkswagen (CARIAD) API client for the ID. range.
//
// Owns the tokens: loads them from the store, refreshes them before they
// expire, signs in again when the refresh token is refused, and retries a
// request once on a 401. Every call goes through `request()`.
//
// `fetch` is injectable: the tests run the whole client against an in-memory
// Volkswagen, never the network.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { BFF_HEADERS, BFF_URL, VwAuthError, isFresh, login, refresh, traceId } from './auth.js';
import { httpsFetch } from './transport.js';
import { createMemoryTokenStore } from './tokenStore.js';

const logger = createLogger({ name: 'vw-api' });

// After a refused sign-in, wait before trying again: every failed attempt
// counts towards the account lock-out on Volkswagen's side.
const AUTH_RETRY_DELAY_MS = 15 * 60 * 1000;

// The status sections ("jobs") the integration reads, when the vehicle has
// the capability of the same name.
export const STATUS_JOBS = [
  'access',
  'charging',
  'climatisation',
  'measurements',
  'fuelStatus',
  'readiness',
  'vehicleHealthInspection',
];

/** A non-2xx answer of the API. `status` is the HTTP status. */
export class VwApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'VwApiError';
    this.status = status;
  }
}

export class VwClient {
  constructor({
    email,
    password,
    fetch: fetchImpl = httpsFetch,
    tokenStore = createMemoryTokenStore(),
    now = () => Date.now(),
  }) {
    this.email = email;
    this.password = password;
    this.fetch = fetchImpl;
    this.tokenStore = tokenStore;
    this.now = now;
    this.tokens = undefined;
    this.tokensLoaded = false;
    this.pendingTokens = undefined;
    this.authFailure = undefined; // { error, until }
  }

  // --- Tokens ---------------------------------------------------------------

  /** A valid access token, refreshing or signing in when needed. */
  async accessToken({ forceRenew = false } = {}) {
    if (!this.pendingTokens) {
      this.pendingTokens = this.#ensureTokens(forceRenew).finally(() => {
        this.pendingTokens = undefined;
      });
    }
    const tokens = await this.pendingTokens;
    return tokens.accessToken;
  }

  async #ensureTokens(forceRenew) {
    if (!this.tokensLoaded) {
      this.tokens = await this.tokenStore.load(this.email);
      this.tokensLoaded = true;
    }
    if (!forceRenew && isFresh(this.tokens, this.now())) {
      return this.tokens;
    }
    if (this.tokens?.refreshToken) {
      try {
        return await this.#store(await refresh(this.tokens, { fetch: this.fetch }));
      } catch (err) {
        if (!(err instanceof VwAuthError)) {
          throw err;
        }
        logger.info('Volkswagen refresh token refused, signing in again');
      }
    }
    if (this.authFailure && this.authFailure.until > this.now()) {
      throw this.authFailure.error;
    }
    try {
      const tokens = await login({
        email: this.email,
        password: this.password,
        fetch: this.fetch,
        logger,
      });
      this.authFailure = undefined;
      return await this.#store(tokens);
    } catch (err) {
      if (err instanceof VwAuthError) {
        this.authFailure = { error: err, until: this.now() + AUTH_RETRY_DELAY_MS };
        await this.tokenStore.clear();
        this.tokens = undefined;
      }
      throw err;
    }
  }

  async #store(tokens) {
    this.tokens = tokens;
    await this.tokenStore.save(this.email, tokens);
    return tokens;
  }

  // --- Requests -------------------------------------------------------------

  /**
   * One API call. Resolves `{ status, data }` (`data` undefined on an empty
   * body). Throws VwApiError on any other status than `okStatuses`.
   */
  async request(method, path, { body, okStatuses = [200, 202, 204, 207] } = {}) {
    let response = await this.#send(method, path, body, await this.accessToken());
    if (response.status === 401) {
      // The token died before its announced expiry: renew it once.
      response = await this.#send(method, path, body, await this.accessToken({ forceRenew: true }));
    }
    if (!okStatuses.includes(response.status)) {
      const detail = await response.text().catch(() => '');
      throw new VwApiError(
        `${method} ${path.split('?')[0]} answered HTTP ${response.status}` +
          (detail ? `: ${detail.slice(0, 200)}` : ''),
        response.status,
      );
    }
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : undefined };
  }

  #send(method, path, body, token) {
    const headers = {
      ...BFF_HEADERS,
      authorization: `Bearer ${token}`,
      'weconnect-trace-id': traceId(),
    };
    return this.fetch(`${BFF_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  }

  // --- Vehicles ---------------------------------------------------------------

  /** The vehicles of the account: `[{ vin, nickname, model, capabilities }]`. */
  async getVehicles() {
    const { data } = await this.request('GET', '/vehicle/v1/vehicles');
    return (data?.data ?? []).filter((vehicle) => typeof vehicle.vin === 'string');
  }

  /** The raw `selectivestatus` of a vehicle, for the given jobs. */
  async getStatus(vin, jobs = STATUS_JOBS) {
    const query = encodeURIComponent(jobs.join(','));
    const { data } = await this.request(
      'GET',
      `/vehicle/v1/vehicles/${encodeURIComponent(vin)}/selectivestatus?jobs=${query}`,
    );
    return data ?? {};
  }

  /** `{ lat, lon, carCapturedTimestamp }`, or null while the car is driving. */
  async getParkingPosition(vin) {
    const { status, data } = await this.request(
      'GET',
      `/vehicle/v1/vehicles/${encodeURIComponent(vin)}/parkingposition`,
      { okStatuses: [200, 204, 404] },
    );
    return status === 200 ? (data?.data ?? null) : null;
  }

  // --- Commands ---------------------------------------------------------------

  #vehiclePath(vin, suffix) {
    return `/vehicle/v1/vehicles/${encodeURIComponent(vin)}/${suffix}`;
  }

  startCharging(vin) {
    return this.request('POST', this.#vehiclePath(vin, 'charging/start'), { body: {} });
  }

  stopCharging(vin) {
    return this.request('POST', this.#vehiclePath(vin, 'charging/stop'), { body: {} });
  }

  /** `targetSOC_pct`: 50 to 100, by steps of 10 on the ID. range. */
  setChargingSettings(vin, settings) {
    return this.request('PUT', this.#vehiclePath(vin, 'charging/settings'), { body: settings });
  }

  startClimatisation(vin, { targetTemperature } = {}) {
    const body = {};
    if (targetTemperature !== undefined) {
      body.targetTemperature = targetTemperature;
      body.targetTemperatureUnit = 'celsius';
    }
    return this.request('POST', this.#vehiclePath(vin, 'climatisation/start'), { body });
  }

  stopClimatisation(vin) {
    return this.request('POST', this.#vehiclePath(vin, 'climatisation/stop'), { body: {} });
  }

  setClimatisationSettings(vin, settings) {
    return this.request('PUT', this.#vehiclePath(vin, 'climatisation/settings'), {
      body: settings,
    });
  }

  /** Lock or unlock: Volkswagen requires the S-PIN of the account. */
  setLocked(vin, locked, spin) {
    return this.request('POST', this.#vehiclePath(vin, locked ? 'access/lock' : 'access/unlock'), {
      body: { spin },
    });
  }

  /** Ask the car to send fresh values (it answers within a few minutes). */
  wakeUp(vin) {
    return this.request('POST', this.#vehiclePath(vin, 'vehiclewakeuptrigger'), { body: {} });
  }
}
