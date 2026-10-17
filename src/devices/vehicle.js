// -----------------------------------------------------------------------------
// Device type: VOLKSWAGEN ID. VEHICLE
//
// One Gladys device per car of the account, keyed on its VIN — the id
// Volkswagen gives the car, stable for its whole life. Each feature below
// maps one value of the normalized status (src/vw/status.js); a feature is
// only published when the car has the capability that reports it, so a car
// without remote climatisation does not show a dead switch.
//
// External ids are forever: the feature keys of FEATURES are part of every
// user's history, scenes and dashboards. Add keys, never rename them.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CATEGORIES,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
  DEVICE_POLL_FREQUENCIES,
} from '@gladysassistant/integration-sdk';
import { hasCapability } from '../vw/status.js';

export const DEVICE_TYPE = 'vehicle';

// Scene trigger key, as declared in the manifest `scene_triggers` field.
export const CHARGING_COMPLETED_TRIGGER = 'charging_completed';

// Bounds of the settings the ID. range accepts.
export const TARGET_BATTERY_LEVEL = { min: 50, max: 100, step: 10 };
export const TARGET_TEMPERATURE = { min: 16, max: 29.5, step: 0.5 };

const binary = (value) => (value === undefined ? undefined : value ? 1 : 0);

/**
 * The features of a vehicle, in display order.
 *   key        : feature key (part of the external id, never renamed)
 *   capability : Volkswagen capability the value depends on
 *   state      : (status) => number | undefined, the value to publish
 *   writable   : the feature is a command (see onSetValue in src/vehicles.js)
 */
export const FEATURES = [
  {
    key: 'battery-level',
    name: 'Battery level',
    category: CATEGORIES.ELECTRICAL_VEHICLE_BATTERY,
    type: TYPES.ELECTRICAL_VEHICLE_BATTERY.BATTERY_LEVEL,
    unit: UNITS.PERCENT,
    min: 0,
    max: 100,
    capability: 'charging',
    state: (s) => s.batteryLevel,
  },
  {
    key: 'range',
    name: 'Electric range',
    category: CATEGORIES.ELECTRICAL_VEHICLE_BATTERY,
    type: TYPES.ELECTRICAL_VEHICLE_BATTERY.BATTERY_RANGE_ESTIMATE,
    unit: UNITS.KM,
    min: 0,
    max: 1000,
    capability: 'charging',
    state: (s) => s.range,
  },
  {
    key: 'battery-temperature',
    name: 'Battery temperature',
    category: CATEGORIES.ELECTRICAL_VEHICLE_BATTERY,
    type: TYPES.ELECTRICAL_VEHICLE_BATTERY.BATTERY_TEMPERATURE,
    unit: UNITS.CELSIUS,
    min: -40,
    max: 80,
    capability: 'measurements',
    state: (s) => s.batteryTemperature,
  },
  {
    key: 'charging',
    name: 'Charging',
    category: CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
    type: TYPES.ELECTRICAL_VEHICLE_CHARGE.CHARGE_ON,
    min: 0,
    max: 1,
    capability: 'charging',
    writable: true,
    state: (s) => binary(s.charging),
  },
  {
    key: 'charge-power',
    name: 'Charging power',
    category: CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
    type: TYPES.ELECTRICAL_VEHICLE_CHARGE.CHARGE_POWER,
    unit: UNITS.KILOWATT,
    min: 0,
    max: 250,
    capability: 'charging',
    state: (s) => s.chargePower,
  },
  {
    key: 'plugged',
    name: 'Charging cable plugged',
    category: CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
    type: TYPES.ELECTRICAL_VEHICLE_CHARGE.PLUGGED,
    min: 0,
    max: 1,
    capability: 'charging',
    state: (s) => binary(s.plugged),
  },
  {
    key: 'target-battery-level',
    name: 'Charge limit',
    category: CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
    type: TYPES.ELECTRICAL_VEHICLE_CHARGE.TARGET_CHARGE_LIMIT,
    unit: UNITS.PERCENT,
    min: TARGET_BATTERY_LEVEL.min,
    max: TARGET_BATTERY_LEVEL.max,
    capability: 'charging',
    writable: true,
    state: (s) => s.targetBatteryLevel,
  },
  {
    key: 'remaining-charging-time',
    name: 'Remaining charging time',
    category: CATEGORIES.DURATION,
    type: TYPES.DURATION.INTEGER,
    unit: UNITS.MINUTES,
    min: 0,
    max: 3000,
    capability: 'charging',
    state: (s) => s.remainingChargingTime,
  },
  {
    key: 'climatisation',
    name: 'Climatisation',
    category: CATEGORIES.ELECTRICAL_VEHICLE_CLIMATE,
    type: TYPES.ELECTRICAL_VEHICLE_CLIMATE.CLIMATE_ON,
    min: 0,
    max: 1,
    capability: 'climatisation',
    writable: true,
    state: (s) => binary(s.climatisationOn),
  },
  {
    key: 'target-temperature',
    name: 'Climatisation temperature',
    category: CATEGORIES.ELECTRICAL_VEHICLE_CLIMATE,
    type: TYPES.ELECTRICAL_VEHICLE_CLIMATE.TARGET_TEMPERATURE,
    unit: UNITS.CELSIUS,
    min: TARGET_TEMPERATURE.min,
    max: TARGET_TEMPERATURE.max,
    capability: 'climatisation',
    writable: true,
    state: (s) => s.targetTemperature,
  },
  {
    // The `probe` type keeps the outside temperature out of the room average.
    key: 'outside-temperature',
    name: 'Outside temperature',
    category: CATEGORIES.TEMPERATURE_SENSOR,
    type: TYPES.TEMPERATURE_SENSOR.PROBE,
    unit: UNITS.CELSIUS,
    min: -50,
    max: 60,
    capability: 'measurements',
    state: (s) => s.outsideTemperature,
  },
  {
    key: 'odometer',
    name: 'Odometer',
    category: CATEGORIES.ELECTRICAL_VEHICLE_STATE,
    type: TYPES.ELECTRICAL_VEHICLE_STATE.ODOMETER,
    unit: UNITS.KM,
    min: 0,
    max: 2000000,
    capability: 'measurements',
    state: (s) => s.odometer,
  },
  {
    key: 'doors-open',
    name: 'Door open',
    category: CATEGORIES.ELECTRICAL_VEHICLE_STATE,
    type: TYPES.ELECTRICAL_VEHICLE_STATE.DOOR_OPENED,
    min: 0,
    max: 1,
    capability: 'access',
    state: (s) => binary(s.doorsOpen),
  },
  {
    key: 'windows-open',
    name: 'Window open',
    category: CATEGORIES.ELECTRICAL_VEHICLE_STATE,
    type: TYPES.ELECTRICAL_VEHICLE_STATE.WINDOW_OPENED,
    min: 0,
    max: 1,
    capability: 'access',
    state: (s) => binary(s.windowsOpen),
  },
  {
    key: 'locked',
    name: 'Locked',
    category: CATEGORIES.ELECTRICAL_VEHICLE_COMMAND,
    type: TYPES.ELECTRICAL_VEHICLE_COMMAND.LOCK,
    min: 0,
    max: 1,
    capability: 'access',
    writable: true,
    state: (s) => binary(s.locked),
  },
];

export const FEATURE_BY_KEY = Object.fromEntries(FEATURES.map((f) => [f.key, f]));

export function vehicleIds(gladys, vin) {
  return gladys.externalIds(DEVICE_TYPE, vin);
}

/** Display name: the nickname set in the Volkswagen app, else the model. */
export function vehicleName(vehicle) {
  const nickname = typeof vehicle.nickname === 'string' ? vehicle.nickname.trim() : '';
  if (nickname) {
    return nickname;
  }
  const model = typeof vehicle.model === 'string' ? vehicle.model.trim() : '';
  return model ? `Volkswagen ${model}` : `Volkswagen ${vehicle.vin.slice(-6)}`;
}

/** The features this vehicle reports, from its capabilities. */
export function featuresOf(vehicle) {
  return FEATURES.filter((feature) => hasCapability(vehicle, feature.capability));
}

/** Discovery payload of one vehicle. */
export function buildVehicleDevice(gladys, vehicle) {
  const ids = vehicleIds(gladys, vehicle.vin);
  return {
    name: vehicleName(vehicle),
    external_id: ids.device,
    model: typeof vehicle.model === 'string' ? vehicle.model : undefined,
    // Gladys polls once a minute at most; src/devices/index.js applies the
    // slower refresh interval of the configuration by skipping polls.
    should_poll: true,
    poll_frequency: DEVICE_POLL_FREQUENCIES.EVERY_MINUTES,
    features: featuresOf(vehicle).map((feature) => ({
      name: feature.name,
      external_id: ids.feature(feature.key),
      category: feature.category,
      type: feature.type,
      ...(feature.unit ? { unit: feature.unit } : {}),
      min: feature.min,
      max: feature.max,
      read_only: !feature.writable,
      // A command is confirmed by the next status read, not by its answer:
      // Volkswagen accepts the request, the car acts a few seconds later.
      has_feedback: false,
      keep_history: true,
    })),
  };
}

/** The `publishStates` entries of a normalized status (known values only). */
export function vehicleStates(gladys, vehicle, status) {
  const ids = vehicleIds(gladys, vehicle.vin);
  return featuresOf(vehicle).flatMap((feature) => {
    const state = feature.state(status);
    return state === undefined
      ? []
      : [{ device_feature_external_id: ids.feature(feature.key), state }];
  });
}

/** Round to the nearest accepted step, within bounds. */
export function snap(value, { min, max, step }) {
  const snapped = Math.round(Number(value) / step) * step;
  return Math.min(max, Math.max(min, snapped));
}
