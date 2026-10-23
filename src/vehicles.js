// -----------------------------------------------------------------------------
// Vehicle service: the bridge between Gladys and the Volkswagen account.
//
// It owns the portal client (rebuilt when the credentials change), the list
// of cars of the account and, for each car, the data points merged from its
// EU Data Act datasets. It turns:
//   - a Gladys poll into a dataset check (at the configured interval),
//   - the new datasets into published states and scene events.
// The portal is read-only: there is no command to send. index.js only wires
// the SDK handlers to it.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { createLogger, validateWidgetImage } from '@gladysassistant/integration-sdk';
import { hasCredentials } from './config.js';
import { downloadPublicImage } from './picture.js';
import { createPollScheduler } from './devices/index.js';
import {
  CHARGING_COMPLETED_TRIGGER,
  buildVehicleDevice,
  vehicleIds,
  vehicleName,
  vehicleStates,
} from './devices/vehicle.js';
import { MESSAGES, VwAuthError } from './vw/auth.js';
import {
  NoDataRequestError,
  VwApiError,
  VwClient,
  describeShape,
  findImageLocation,
} from './vw/client.js';
import {
  DATASET_SEQ_SPAN,
  chargeFieldsOfNewestDataset,
  mergePoints,
  parseDataset,
  statusFromPoints,
} from './vw/status.js';

const logger = createLogger({ name: 'vehicles' });

// An unchanged value is re-sent this often, so it stays recently dated in
// Gladys (publishChangedStates heartbeat).
const STATE_HEARTBEAT_MS = 30 * 60 * 1000;
// On the first read, merge this many of the newest datasets: a parked car
// delivers few data points per dataset.
const MAX_BACKFILL = 4;
// A car picture that could not be fetched (or is too large for a widget) is
// tried again after this delay, not on every dashboard refresh.
const PICTURE_RETRY_MS = 60 * 60 * 1000;

const NOT_CONFIGURED = MESSAGES.missingCredentials;

function unreachable(err) {
  // Gladys caps the status message: keep the cause short.
  const cause = String(err.message).slice(0, 120);
  return {
    en: `Cannot reach the Volkswagen portal: ${cause}`,
    fr: `Impossible de joindre le portail Volkswagen : ${cause}`,
  };
}

export const NO_DATA_REQUEST = {
  en: 'No data reaches Gladys yet: enable the continuous data request of your car on the Volkswagen EU Data Act portal (see the documentation).',
  fr: 'Aucune donnée n’arrive encore : activez la demande de données continue de votre voiture sur le portail EU Data Act de Volkswagen (voir la documentation).',
};

/** A request the user cannot run as is: the message is shown in Gladys. */
export class CommandError extends Error {}

export class VehicleService {
  /**
   * @param {object} gladys the SDK instance
   * @param {object} [options]
   * @param {(config) => VwClient} [options.createClient] builds the portal client
   * @param {() => number} [options.now] clock, for the tests
   * @param {(url) => Promise<Buffer>} [options.downloadPicture] fetches the
   *   picture configured by the user (public https address)
   */
  constructor(
    gladys,
    { createClient, now = () => Date.now(), downloadPicture = downloadPublicImage } = {},
  ) {
    this.gladys = gladys;
    this.createClient =
      createClient ??
      ((config) => new VwClient({ email: config.email, password: config.password }));
    this.now = now;
    this.downloadPicture = downloadPicture;
    this.config = undefined;
    this.client = undefined;
    this.vehicles = [];
    this.vehiclesLoaded = false;
    this.data = new Map(); // vin -> { identifier, points, lastCreatedOn, datasets }
    this.statuses = new Map(); // vin -> flat status
    this.pictures = new Map(); // vin -> { location, key, base64 } | { location, failedAt }
    this.relationPictures = new Map(); // vin -> { location, at }
    this.scheduler = createPollScheduler(now);
    this.connection = undefined; // last reported { connected, message }
    this.onStatus = () => {};
  }

  /** Apply a (new) configuration. Credentials changes start a new session. */
  configure(config) {
    const previous = this.config;
    this.config = config;
    const credentialsChanged =
      !previous || previous.email !== config.email || previous.password !== config.password;
    if (credentialsChanged) {
      this.client = hasCredentials(config) ? this.createClient(config) : undefined;
      this.vehicles = [];
      this.vehiclesLoaded = false;
      this.data.clear();
      this.statuses.clear();
      this.pictures.clear();
      this.relationPictures.clear();
      this.scheduler.clear();
    }
    return credentialsChanged;
  }

  get configured() {
    return Boolean(this.client);
  }

  // --- Connection status ------------------------------------------------------

  /** Report the account status in the Configuration screen, on change only. */
  async reportConnection(connected, message) {
    const key = JSON.stringify({ connected, message });
    if (this.connection === key) {
      return;
    }
    this.connection = key;
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      logger.warn(`Could not report the connection status (${err.message})`);
    });
  }

  /** Make the next outcome be reported, even if unchanged. */
  forgetConnectionStatus() {
    this.connection = undefined;
  }

  /** Run an API call, reflecting its outcome in the connection status. */
  async #withAccount(work) {
    if (!this.client) {
      await this.reportConnection(false, NOT_CONFIGURED);
      throw new CommandError('The Volkswagen account is not configured');
    }
    try {
      const result = await work(this.client);
      await this.reportConnection(true);
      return result;
    } catch (err) {
      if (err instanceof VwAuthError) {
        await this.reportConnection(false, err.userMessage);
      } else if (err instanceof NoDataRequestError) {
        // The account works, but the portal has nothing to deliver.
        await this.reportConnection(false, NO_DATA_REQUEST);
      } else if (err instanceof VwApiError) {
        // The account works, one call failed (portal hiccup, rate limit...).
        if (err.status === 429) {
          logger.warn('Volkswagen rate limit reached: slow down the refresh interval');
        }
      } else {
        // Sign-in refused by the front door, network down...: the account
        // is unusable, say so in the Configuration screen too.
        await this.reportConnection(false, unreachable(err));
      }
      throw err;
    }
  }

  // --- Vehicles ---------------------------------------------------------------

  /** Fetch the cars of the account. */
  async loadVehicles() {
    if (!this.client) {
      this.vehicles = [];
      await this.reportConnection(false, NOT_CONFIGURED);
      return this.vehicles;
    }
    this.vehicles = await this.#withAccount((client) => client.getVehicles());
    this.vehiclesLoaded = true;
    logger.info(`${this.vehicles.length} vehicle(s) on the Volkswagen account`);
    return this.vehicles;
  }

  async #ensureVehicles() {
    if (!this.vehiclesLoaded) {
      await this.loadVehicles();
    }
  }

  /** The discovery payload: one device per car. */
  discoveredDevices() {
    return this.vehicles.map((vehicle) => buildVehicleDevice(this.gladys, vehicle));
  }

  findVehicle(externalId) {
    return this.vehicles.find(
      (vehicle) => vehicleIds(this.gladys, vehicle.vin).device === externalId,
    );
  }

  statusOf(vin) {
    return this.statuses.get(vin);
  }

  // --- Pictures ---------------------------------------------------------------

  /**
   * The picture of a car, ready for a widget: `{ key, base64 }`, or undefined
   * when there is none or it cannot be served (too large, not an image...).
   * The address the user configured wins; else the portal's own picture of
   * THIS car, if the portal ever gives one. Downloaded once per address; the
   * key changes with the address, as the core caches an image one hour by key.
   */
  async vehiclePicture(vehicle) {
    if (!vehicle || !this.client) {
      return undefined;
    }
    const configured = this.config?.vehicle_image_url || undefined;
    const location = configured ?? vehicle.image ?? (await this.#relationPicture(vehicle));
    if (!location) {
      return undefined;
    }
    const cached = this.pictures.get(vehicle.vin);
    if (cached?.location === location) {
      if (cached.base64) return cached;
      if (this.now() - cached.failedAt < PICTURE_RETRY_MS) return undefined;
    }
    try {
      // The configured address is public: no Volkswagen session goes there.
      const body = configured
        ? await this.downloadPicture(configured)
        : (await this.client.getVehicleImage(location)).body;
      const base64 = body.toString('base64');
      const problems = validateWidgetImage(base64);
      if (problems.length > 0) {
        throw new Error(problems.join('; '));
      }
      const key = `vw-${createHash('sha256').update(location).digest('hex').slice(0, 24)}`;
      const picture = { location, key, base64 };
      this.pictures.set(vehicle.vin, picture);
      return picture;
    } catch (err) {
      logger.warn(
        `${vehicleName(vehicle)}: no picture for the widget ` +
          `(${configured ? 'configured address' : 'portal'}: ${err.message})`,
      );
      this.pictures.set(vehicle.vin, { location, failedAt: this.now(), configured: !!configured });
      return undefined;
    }
  }

  /** True when the picture the user configured could not be served. */
  configuredPictureFailed(vehicle) {
    const cached = this.pictures.get(vehicle.vin);
    return Boolean(
      cached?.configured && !cached.base64 && cached.location === this.config?.vehicle_image_url,
    );
  }

  /**
   * The vehicle list has no picture location: look in the car's relation,
   * once per car and session (and at most once an hour after a failure).
   * When none is found, log the shape of both answers — field names only —
   * so the right field can be read in a next version.
   */
  async #relationPicture(vehicle) {
    const checked = this.relationPictures.get(vehicle.vin);
    if (checked && (checked.location || this.now() - checked.at < PICTURE_RETRY_MS)) {
      return checked.location;
    }
    let location;
    let relationShape;
    try {
      const relation = await this.client.getVehicleRelation(vehicle.vin);
      location = findImageLocation(relation);
      relationShape = describeShape(relation);
    } catch (err) {
      relationShape = [`(unavailable: ${err.message})`];
    }
    this.relationPictures.set(vehicle.vin, { location, at: this.now() });
    if (!location) {
      logger.info(
        `${vehicleName(vehicle)}: the portal gives no picture location. ` +
          `Vehicle fields: ${(vehicle.shape ?? []).join(', ') || '(none)'}. ` +
          `Relation fields: ${relationShape.join(', ') || '(none)'}`,
      );
    }
    return location;
  }

  /** The raw base64 of a picture key a widget content declared (onWidgetGetImage). */
  async pictureByKey(key) {
    for (const vehicle of this.vehicles) {
      const picture = await this.vehiclePicture(vehicle);
      if (picture?.key === key) {
        return picture.base64;
      }
    }
    throw new Error(`Unknown picture ${key}`);
  }

  /**
   * The name to show for a car: the one the user gave the device in Gladys,
   * else the nickname of the Volkswagen app, else the model.
   */
  displayName(vehicle) {
    const externalId = vehicleIds(this.gladys, vehicle.vin).device;
    const device = (this.gladys.devices ?? []).find((d) => d.external_id === externalId);
    const name = typeof device?.name === 'string' ? device.name.trim() : '';
    return name || vehicleName(vehicle);
  }

  // --- Status -----------------------------------------------------------------

  /**
   * Gladys polls a vehicle device (once a minute). Checks the portal only
   * when due. Resolves true when the portal was read.
   */
  async poll(device) {
    await this.#ensureVehicles();
    const vehicle = this.findVehicle(device.external_id);
    if (!vehicle) {
      logger.debug(`Poll of an unknown vehicle ${device.external_id}`);
      return false;
    }
    if (!this.scheduler.isDue(vehicle.vin, this.config.poll_frequency)) {
      return false;
    }
    await this.refreshStatus(vehicle);
    return true;
  }

  /**
   * Download the car's new datasets, merge them, publish the states and the
   * events. Resolves the flat status.
   */
  async refreshStatus(vehicle) {
    // Recorded before the calls: a failed read (portal hiccup, no data
    // request yet...) waits for the next interval too, instead of retrying
    // every minute.
    this.scheduler.markRead(vehicle.vin);
    const known = this.data.get(vehicle.vin) ?? {
      identifier: undefined,
      points: new Map(),
      lastCreatedOn: 0,
      datasets: 0,
    };
    const updated = await this.#withAccount(async (client) => {
      const identifier = known.identifier ?? (await client.getDataRequest(vehicle.vin));
      const list = await client.listDatasets(vehicle.vin, identifier);
      const fresh = list.filter((dataset) => dataset.createdOn > known.lastCreatedOn);
      const pending = known.datasets === 0 ? fresh.slice(-MAX_BACKFILL) : fresh;
      let { points, lastCreatedOn, datasets } = known;
      for (const dataset of pending) {
        const content = await client.downloadDataset(vehicle.vin, identifier, dataset.name);
        datasets += 1;
        points = mergePoints(points, parseDataset(content, datasets * DATASET_SEQ_SPAN));
        lastCreatedOn = Math.max(lastCreatedOn, dataset.createdOn);
      }
      if (pending.length > 0) {
        // One line per new dataset (every 15 minutes at best): what the car
        // reported about its charge, to check against the Volkswagen app.
        const newest = new Date(pending.at(-1).createdOn).toISOString();
        const fields = chargeFieldsOfNewestDataset(points);
        logger.info(
          `${vehicleName(vehicle)}: ${pending.length} new dataset(s), newest ${newest}; ` +
            `charge fields: ${fields.join(', ') || '(none)'}`,
        );
      }
      return { identifier, points, lastCreatedOn, datasets };
    });
    this.data.set(vehicle.vin, updated);
    if (updated.datasets === 0) {
      // The data request exists, the car has not delivered anything yet.
      logger.info(`${vehicleName(vehicle)}: no dataset on the portal yet`);
      return this.statuses.get(vehicle.vin);
    }

    const status = statusFromPoints(updated.points);
    const previous = this.statuses.get(vehicle.vin);
    this.statuses.set(vehicle.vin, status);
    await this.gladys.publishChangedStates(vehicleStates(this.gladys, vehicle, status), {
      heartbeat: STATE_HEARTBEAT_MS,
    });
    if (isChargeCompletion(previous, status)) {
      logger.info(`${vehicleName(vehicle)}: charge completed at ${status.batteryLevel}%`);
      // One event per transition (charging -> not charging), never per poll.
      await this.gladys.publishSceneEvent(CHARGING_COMPLETED_TRIGGER, {
        device: vehicleIds(this.gladys, vehicle.vin).device,
        battery_level: status.batteryLevel ?? null,
        range: status.range ?? null,
      });
    }
    this.onStatus(vehicle, status);
    return status;
  }
}

/** The charge just ended because the battery reached its target. */
export function isChargeCompletion(previous, status) {
  if (previous?.charging !== true || status.charging !== false) {
    return false;
  }
  if (status.chargeComplete) {
    return true;
  }
  return (
    status.batteryLevel !== undefined &&
    status.targetBatteryLevel !== undefined &&
    status.batteryLevel >= status.targetBatteryLevel
  );
}
