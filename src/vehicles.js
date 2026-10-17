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

import { createLogger } from '@gladysassistant/integration-sdk';
import { hasCredentials } from './config.js';
import { createPollScheduler } from './devices/index.js';
import {
  CHARGING_COMPLETED_TRIGGER,
  buildVehicleDevice,
  vehicleIds,
  vehicleName,
  vehicleStates,
} from './devices/vehicle.js';
import { MESSAGES, VwAuthError } from './vw/auth.js';
import { NoDataRequestError, VwApiError, VwClient } from './vw/client.js';
import { mergePoints, parseDataset, statusFromPoints } from './vw/status.js';

const logger = createLogger({ name: 'vehicles' });

// An unchanged value is re-sent this often, so it stays recently dated in
// Gladys (publishChangedStates heartbeat).
const STATE_HEARTBEAT_MS = 30 * 60 * 1000;
// On the first read, merge this many of the newest datasets: a parked car
// delivers few data points per dataset.
const MAX_BACKFILL = 4;
// Room left for the points of one dataset in the merge order (see parseDataset).
const DATASET_SEQ_SPAN = 1_000_000;

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
   */
  constructor(gladys, { createClient, now = () => Date.now() } = {}) {
    this.gladys = gladys;
    this.createClient =
      createClient ??
      ((config) => new VwClient({ email: config.email, password: config.password }));
    this.now = now;
    this.config = undefined;
    this.client = undefined;
    this.vehicles = [];
    this.vehiclesLoaded = false;
    this.data = new Map(); // vin -> { identifier, points, lastCreatedOn, datasets }
    this.statuses = new Map(); // vin -> flat status
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
        logger.debug(`${vehicleName(vehicle)}: ${pending.length} new dataset(s)`);
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
