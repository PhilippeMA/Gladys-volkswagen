// -----------------------------------------------------------------------------
// Normalization of the raw `selectivestatus` answer into a flat vehicle state.
//
// The raw answer nests every value under `<job>.<section>.value`, may answer
// a job with `{ error }` instead (no licence, car asleep...), and moves keys
// between firmware versions. This module reads each value from where the
// ID. range puts it, with the known fallbacks, and leaves `undefined` for
// what the car did not report: the caller publishes only what it got.
// -----------------------------------------------------------------------------

const KELVIN_OFFSET = 273.15;

// Charging states that mean "the charge reached its target".
const CHARGE_COMPLETE_STATES = new Set([
  'chargePurposeReachedAndConservation',
  'chargePurposeReachedAndNotConservationCharging',
  'conservation',
]);

const CLIMATISATION_OFF_STATES = new Set(['off', 'invalid', 'unsupported']);

function section(data, job, name) {
  const value = data?.[job]?.[name]?.value;
  return value && typeof value === 'object' ? value : undefined;
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function kelvinToCelsius(value) {
  const kelvin = number(value);
  return kelvin === undefined ? undefined : Math.round((kelvin - KELVIN_OFFSET) * 10) / 10;
}

function average(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.round(((a + b) / 2) * 10) / 10;
}

function statusList(entry) {
  return Array.isArray(entry?.status) ? entry.status : [];
}

/**
 * @param {object} data raw selectivestatus answer
 * @returns {object} flat state; every key may be undefined
 */
export function normalizeStatus(data) {
  const battery = section(data, 'charging', 'batteryStatus');
  const chargingStatus = section(data, 'charging', 'chargingStatus');
  const chargingSettings = section(data, 'charging', 'chargingSettings');
  const plug = section(data, 'charging', 'plugStatus');
  const climatisation = section(data, 'climatisation', 'climatisationStatus');
  const climatisationSettings = section(data, 'climatisation', 'climatisationSettings');
  const fuelLevel = section(data, 'measurements', 'fuelLevelStatus');
  const range = section(data, 'measurements', 'rangeStatus');
  const fuelRange = section(data, 'fuelStatus', 'rangeStatus');
  const odometer = section(data, 'measurements', 'odometerStatus');
  const outside = section(data, 'measurements', 'temperatureOutsideStatus');
  const batteryTemperature = section(data, 'measurements', 'temperatureBatteryStatus');
  const access = section(data, 'access', 'accessStatus');
  const maintenance = section(data, 'vehicleHealthInspection', 'maintenanceStatus');
  const readiness = data?.readiness?.readinessStatus;

  const chargingState = chargingStatus?.chargingState;
  const climatisationState = climatisation?.climatisationState;
  const doors = Array.isArray(access?.doors) ? access.doors : undefined;
  const windows = Array.isArray(access?.windows) ? access.windows : undefined;

  return {
    batteryLevel:
      number(battery?.currentSOC_pct) ??
      number(fuelLevel?.currentSOC_pct) ??
      number(fuelRange?.primaryEngine?.currentSOC_pct),
    range:
      number(battery?.cruisingRangeElectric_km) ??
      number(range?.electricRange) ??
      number(fuelRange?.primaryEngine?.remainingRange_km) ??
      number(range?.totalRange_km),
    batteryTemperature: average(
      kelvinToCelsius(batteryTemperature?.temperatureHvBatteryMin_K),
      kelvinToCelsius(batteryTemperature?.temperatureHvBatteryMax_K),
    ),

    chargingState: typeof chargingState === 'string' ? chargingState : undefined,
    charging: chargingState === undefined ? undefined : chargingState === 'charging',
    chargeComplete:
      chargingState === undefined ? undefined : CHARGE_COMPLETE_STATES.has(chargingState),
    chargePower: number(chargingStatus?.chargePower_kW),
    chargeRate: number(chargingStatus?.chargeRate_kmph),
    remainingChargingTime: number(chargingStatus?.remainingChargingTimeToComplete_min),
    targetBatteryLevel: number(chargingSettings?.targetSOC_pct),
    plugged:
      plug?.plugConnectionState === undefined
        ? undefined
        : plug.plugConnectionState === 'connected',
    plugLocked: plug?.plugLockState === undefined ? undefined : plug.plugLockState === 'locked',
    externalPower:
      plug?.externalPower === undefined
        ? undefined
        : plug.externalPower === 'available' || plug.externalPower === 'active',

    climatisationState: typeof climatisationState === 'string' ? climatisationState : undefined,
    climatisationOn:
      climatisationState === undefined
        ? undefined
        : !CLIMATISATION_OFF_STATES.has(climatisationState),
    remainingClimatisationTime: number(climatisation?.remainingClimatisationTime_min),
    targetTemperature: number(climatisationSettings?.targetTemperature_C),

    odometer: number(odometer?.odometer) ?? number(maintenance?.mileage_km),
    outsideTemperature: kelvinToCelsius(outside?.temperatureOutside_K),
    inspectionDueDays: number(maintenance?.inspectionDue_days),
    inspectionDueKm: number(maintenance?.inspectionDue_km),

    locked:
      access?.doorLockStatus === 'locked'
        ? true
        : access?.doorLockStatus === 'unlocked'
          ? false
          : undefined,
    doorsOpen: doors ? doors.some((door) => statusList(door).includes('open')) : undefined,
    windowsOpen: windows
      ? windows.some((window) => statusList(window).includes('open'))
      : undefined,

    online:
      typeof readiness?.connectionState?.isOnline === 'boolean'
        ? readiness.connectionState.isOnline
        : undefined,
    capturedAt: battery?.carCapturedTimestamp ?? chargingStatus?.carCapturedTimestamp,
  };
}

/** The status jobs worth asking for, from the capabilities of the vehicle. */
export function jobsFor(vehicle, allJobs) {
  const capabilities = Array.isArray(vehicle?.capabilities) ? vehicle.capabilities : [];
  if (capabilities.length === 0) {
    // No capability list (older answer): ask for everything, the API answers
    // `{ error }` for the jobs the car does not have.
    return allJobs;
  }
  const enabled = new Set(
    capabilities
      // A non-empty `status` means disabled (licence expired, not activated...).
      .filter((capability) => !Array.isArray(capability.status) || capability.status.length === 0)
      .map((capability) => capability.id),
  );
  return allJobs.filter((job) => enabled.has(job));
}

/** True when the vehicle exposes (and has enabled) a capability. */
export function hasCapability(vehicle, id) {
  const capabilities = Array.isArray(vehicle?.capabilities) ? vehicle.capabilities : undefined;
  if (!capabilities || capabilities.length === 0) {
    // Unknown: assume the usual ID. equipment.
    return true;
  }
  return capabilities.some(
    (capability) =>
      capability.id === id && (!Array.isArray(capability.status) || capability.status.length === 0),
  );
}
