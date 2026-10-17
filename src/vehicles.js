// -----------------------------------------------------------------------------
// Vehicle service: the bridge between Gladys and the Volkswagen account.
//
// It owns the API client (rebuilt when the credentials change), the list of
// cars of the account, the last status read for each one, and turns:
//   - a Gladys poll into a status read (at the configured interval),
//   - a status read into published states and scene events,
//   - a Gladys command into a Volkswagen command.
// index.js only wires the SDK handlers to it.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { hasCredentials } from './config.js';
import { createPollScheduler } from './devices/index.js';
import {
  CHARGING_COMPLETED_TRIGGER,
  FEATURE_BY_KEY,
  TARGET_BATTERY_LEVEL,
  TARGET_TEMPERATURE,
  buildVehicleDevice,
  snap,
  vehicleIds,
  vehicleName,
  vehicleStates,
} from './devices/vehicle.js';
import { VwAuthError } from './vw/auth.js';
import { STATUS_JOBS, VwApiError, VwClient } from './vw/client.js';
import { jobsFor, normalizeStatus } from './vw/status.js';

const logger = createLogger({ name: 'vehicles' });

// An unchanged value is re-sent this often, so it stays recently dated in
// Gladys (publishChangedStates heartbeat).
const STATE_HEARTBEAT_MS = 30 * 60 * 1000;
// After a command, read the car again once it had time to act.
const CONFIRM_DELAY_MS = 45 * 1000;

const NOT_CONFIGURED = {
  en: 'Enter the email address and the password of your Volkswagen account.',
  fr: 'Renseignez l’adresse e-mail et le mot de passe de votre compte Volkswagen.',
};

function unreachable(err) {
  // Gladys caps the status message: keep the cause short.
  const cause = String(err.message).slice(0, 120);
  return {
    en: `Cannot reach the Volkswagen account: ${cause}`,
    fr: `Impossible de joindre le compte Volkswagen : ${cause}`,
  };
}

/** A command the user cannot run as is: the message is shown in Gladys. */
export class CommandError extends Error {}

export class VehicleService {
  /**
   * @param {object} gladys the SDK instance
   * @param {object} [options]
   * @param {(config) => VwClient} [options.createClient] builds the API client
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
    this.statuses = new Map(); // vin -> normalized status
    this.rawSettings = new Map(); // vin -> raw chargingSettings, re-sent with a change
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
      this.statuses.clear();
      this.rawSettings.clear();
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
      } else if (err instanceof VwApiError) {
        // The account works, one call failed (car asleep, rate limit...).
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
   * Gladys polls a vehicle device (once a minute). Reads the car only when
   * due. Resolves true when the car was read.
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

  /** Read the status of a car now, publish its states and events. */
  async refreshStatus(vehicle) {
    // Recorded before the call: a failed read (rate limit, car offline...)
    // waits for the next interval too, instead of retrying every minute.
    this.scheduler.markRead(vehicle.vin);
    const raw = await this.#withAccount((client) =>
      client.getStatus(vehicle.vin, jobsFor(vehicle, STATUS_JOBS)),
    );
    const status = normalizeStatus(raw);
    const previous = this.statuses.get(vehicle.vin);
    this.statuses.set(vehicle.vin, status);
    const chargingSettings = raw?.charging?.chargingSettings?.value;
    if (chargingSettings) {
      this.rawSettings.set(vehicle.vin, chargingSettings);
    }

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

  // --- Commands ---------------------------------------------------------------

  /** Gladys sets a writable feature of a vehicle. */
  async setValue(device, feature, value) {
    await this.#ensureVehicles();
    const vehicle = this.findVehicle(device.external_id);
    if (!vehicle) {
      throw new CommandError(`Unknown vehicle ${device.external_id}`);
    }
    const ids = vehicleIds(this.gladys, vehicle.vin);
    const key = feature.external_id.slice(ids.device.length + 1);
    if (!FEATURE_BY_KEY[key]?.writable) {
      throw new CommandError(`The feature ${key} cannot be controlled`);
    }
    const published = await this.#withAccount((client) =>
      this.#runCommand(client, vehicle, key, Number(value)),
    );
    logger.info(`${vehicleName(vehicle)}: ${key} <- ${published}`);
    // Show the requested value now; the read below confirms (or reverts) it.
    await this.gladys.publishChangedStates([
      { device_feature_external_id: feature.external_id, state: published },
    ]);
    this.scheduler.readSoon(vehicle.vin, CONFIRM_DELAY_MS);
  }

  /** Send one command; resolves the value to show in Gladys. */
  async #runCommand(client, vehicle, key, value) {
    const { vin } = vehicle;
    const status = this.statuses.get(vin) ?? {};
    switch (key) {
      case 'charging':
        await (value === 1 ? client.startCharging(vin) : client.stopCharging(vin));
        return value === 1 ? 1 : 0;
      case 'target-battery-level': {
        const target = snap(value, TARGET_BATTERY_LEVEL);
        const settings = { targetSOC_pct: target };
        const current = this.rawSettings.get(vin);
        // Send the current charging current along: the API applies the body
        // as the new settings.
        if (typeof current?.maxChargeCurrentAC === 'string') {
          settings.maxChargeCurrentAC = current.maxChargeCurrentAC;
        }
        await client.setChargingSettings(vin, settings);
        return target;
      }
      case 'climatisation':
        if (value === 1) {
          await client.startClimatisation(vin, { targetTemperature: status.targetTemperature });
          return 1;
        }
        await client.stopClimatisation(vin);
        return 0;
      case 'target-temperature': {
        const target = snap(value, TARGET_TEMPERATURE);
        await client.setClimatisationSettings(vin, {
          targetTemperature: target,
          targetTemperatureUnit: 'celsius',
        });
        return target;
      }
      case 'locked':
        if (!this.config.spin) {
          throw new CommandError(
            'Locking and unlocking need the S-PIN of the Volkswagen account: enter it in the configuration',
          );
        }
        await client.setLocked(vin, value === 1, this.config.spin);
        return value === 1 ? 1 : 0;
      default:
        throw new CommandError(`The feature ${key} cannot be controlled`);
    }
  }

  /** Ask a car to send fresh values to Volkswagen, then read it soon. */
  async wakeUp(externalId) {
    await this.#ensureVehicles();
    const vehicle = this.findVehicle(externalId);
    if (!vehicle) {
      throw new CommandError(`Unknown vehicle ${externalId}`);
    }
    await this.#withAccount((client) => client.wakeUp(vehicle.vin));
    this.scheduler.readSoon(vehicle.vin, CONFIRM_DELAY_MS);
    return vehicle;
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
