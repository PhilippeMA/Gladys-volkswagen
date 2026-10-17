// -----------------------------------------------------------------------------
// From the EU Data Act datasets to a flat vehicle state.
//
// A dataset is a flat list of data points `{ key, dataFieldName, value,
// timestampUtc }`: `key` is the GUID of the data point in Volkswagen's data
// dictionary, `dataFieldName` its name (sometimes generic), `value` always a
// string. A parked car delivers few points, so the points of successive
// datasets are merged, the newest one winning per data point. The flat state
// reads each value from the fields the ID. range uses, with the known
// fallbacks, and leaves `undefined` for what the car did not report: the
// caller publishes only what it got.
//
// The field names and GUIDs come from Volkswagen's EU Data Act data
// dictionary, as published by the ioBroker.vw-connect and evcc projects.
// -----------------------------------------------------------------------------

// GUID -> field name, for the data points this integration reads: a dataset
// may name them generically.
const KNOWN_KEYS = {
  '0811aa96-26d8-3d5f-8bd7-77be06612d85': 'charging_state_report.current_charge_state',
  '3581f1e0-580b-3f18-aa73-6fbf037b841e': 'charging_state_report.current_charge_state',
  '96c211b4-f8fb-3f40-b7cf-6a1cd12cce6d': 'charging_state_report.current_charge_state',
  'a08cca2b-ed42-37bc-b160-d015ce205d3d': 'charging_state_report.current_charge_state',
  '0ba7abe4-14d5-3541-adec-31be0ecdfcc9': 'charging_state_report.charging_scenario',
  'a8b48aad-8cd4-3534-b64d-6c8abd600972': 'charging_state_report.charging_scenario',
  'abf1baf4-86e6-35e5-9936-df515fd1743c': 'charging_state_report.charging_scenario',
  'c7aa1c25-7c32-3b9a-a732-1d9fd786bbfe': 'charging_state_report.charging_scenario',
  '9da735bb-c5d5-39f8-bf53-0fa2a367aa8f': 'charging_state',
  '153e8c40-4c6c-3c17-a11b-0ecc35d55b81': 'cruising_range_combined',
  '55e0d40b-38ed-3cb5-9dcd-6193df6fc493': 'cruising_range_primary_engine',
  '0ca40e18-0564-3eda-bcc0-7aee9ef44f04': 'cruising_range_primary_engine', // ID.3
  '30cc36fd-71ca-3c09-9296-e94ebd47bd2b': 'mileage.value',
  '69d437d3-7baa-38bc-b842-f5baf99ddade': 'mileage.value',
  '75d65f00-5fa8-334a-826d-e73e91fe5c8d': 'mileage.value',
  '41c0805c-43e5-313e-9dfb-356cb8d20f7c': 'mileage',
  '506cb83e-f99f-3af3-bbeb-0429b69a78d9': 'battery_state_report.soc',
  '7bddd5e7-43a4-3878-bd63-9502782f77a5': 'battery_state_report.soc',
  '93b55324-6628-36df-8f76-8eba797fc59c': 'battery_state_report.soc',
  'bd4b6d50-b574-31e6-8141-8787ca5fec8c': 'battery_state_report.soc',
  'ae0294b4-1286-3e98-a818-1485b8d88430': 'state_of_charge',
  'f89ed652-d104-3fa6-b7e2-ab7543309e7b': 'hv_soc',
  'ac1108b1-b8cc-3db9-a663-03d387e42223': 'battery_level_HV.value',
  '44ed0d61-98c4-36df-b860-b077929a5797': 'battery_state_report.charge_power',
  '8087d3b7-03bd-350a-95ef-bd8cb3ba20fa': 'battery_state_report.charge_power',
  '885d1abd-799d-344a-bf02-0d07c6d6eebf': 'battery_state_report.charge_power',
  'c8cb205f-01c6-3c81-bda1-059b99ae6515': 'battery_state_report.charge_power',
  '978be4ed-2f7f-32c0-8644-18e7b0dde741': 'charging_power',
  '76acaa98-37ef-3466-b013-21c77ed343ae': 'settings.target_soc',
  '86140011-db48-30c8-8172-30a90b39006e': 'settings.target_soc',
  'b3b04f31-b10e-38aa-b8ad-c0da7c06caea': 'settings.target_soc',
  'e21d4d25-98bc-3016-a234-1ad061cc313b': 'settings.target_soc',
  'cf28f7d9-6201-30b8-82e5-a461968d30dc': 'remaining_charging_time',
  '7405c11f-4d20-36d2-8381-18364aa1f444': 'battery_state_report.remaining_charging_time_complete',
  '7b149fa0-1cae-35e3-9f81-49656d2393b8': 'battery_state_report.remaining_charging_time_complete',
  'c32ae9c8-b3c1-3334-865e-ddce83159935': 'battery_state_report.remaining_charging_time_complete',
  'cad65f6f-17c5-377b-b030-821ffaf27dd5': 'battery_state_report.remaining_charging_time_complete',
  '37d8c0c0-9677-3823-8b32-d0a5001cb0d0': 'plug_state',
  '6b61d861-e8c2-3600-a9ba-2f5da9ac3410': 'plug_connection_state',
  'c111830c-f959-30d2-859a-ea996190d864': 'plug_state',
  'b6ea5ae8-53ff-386d-8415-1baa0602bbb6': 'outdoor_temperature',
  '6810b781-e54a-35e8-af98-fcdefb54bac6': 'outside_temperature',
  'ad12b2c9-2290-3147-bc72-f5adbf659d9b': 'locked',
  'bd917b58-82bd-3c34-a006-747ca5aec03d': 'locked',
};

// Same meaning, another name depending on the model.
const FIELD_ALIASES = {
  charging_plug1_connectionstate: 'plug_state',
};

// Integers the portal sends when a sensor has no reading.
const SENTINELS = new Set([65535, 2147483647, 4294967295]);
// Fields whose largest value is the freshest (a dataset mixes snapshots).
const MONOTONIC_FIELDS = new Set(['mileage', 'mileage.value']);

// `current_charge_state` values, in the order of the enum (some datasets send
// the index instead of the label), and the state names this integration uses.
const CHARGE_STATES = [
  ['CHARGE_STATE_INVALID', undefined],
  ['CHARGE_STATE_NOT_READY_FOR_CHARGING', 'notReadyForCharging'],
  ['CHARGE_STATE_READY_FOR_CHARGING', 'readyForCharging'],
  ['CHARGE_STATE_CHARGING_HV_BATTERY', 'charging'],
  ['CHARGE_STATE_DISCHARGING', 'discharging'],
  [
    'CHARGE_STATE_CHARGE_PURPOSE_REACHED_AND_NOT_CONSERVATION_CHARGING',
    'chargePurposeReachedAndNotConservationCharging',
  ],
  ['CHARGE_STATE_CHARGE_PURPOSE_REACHED_AND_CONSERVATION', 'chargePurposeReachedAndConservation'],
  ['CHARGE_STATE_CONSERVATION_CHARGING', 'conservation'],
  ['CHARGE_STATE_CHARGING_ERROR', 'error'],
];
const CHARGE_STATE_BY_LABEL = Object.fromEntries(CHARGE_STATES);

// The flat `charging_state` field.
const FLAT_CHARGING_STATES = {
  charging: 'charging',
  completed: 'chargePurposeReachedAndNotConservationCharging',
  conservationcharging: 'conservation',
  off: 'off',
  error: 'error',
};

// States that mean "the charge reached its target".
const CHARGE_COMPLETE_STATES = new Set([
  'chargePurposeReachedAndConservation',
  'chargePurposeReachedAndNotConservationCharging',
  'conservation',
]);

const KELVIN_OFFSET = 273.15;

function isSentinel(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return false;
  }
  return SENTINELS.has(number) || (number === -1 && /remaining_charging_time/.test(name));
}

/**
 * The data points of one dataset, keyed by data point (`key`, else name):
 * `Map<id, { name, value, timestamp, seq }>`. `seq` orders the points of
 * successive datasets: pass a higher `base` for a newer dataset.
 */
export function parseDataset(dataset, base = 0) {
  const points = new Map();
  const data = Array.isArray(dataset?.Data) ? dataset.Data : [];
  data.forEach((item, index) => {
    if (!item || item.value === undefined || item.value === null) {
      return;
    }
    const value = String(item.value).trim();
    let name = KNOWN_KEYS[item.key] ?? item.dataFieldName ?? '';
    name = FIELD_ALIASES[name] ?? name;
    const id = item.key || name;
    if (!id || value === '' || isSentinel(value, name)) {
      return;
    }
    const point = {
      name,
      value,
      timestamp: Date.parse(item.timestampUtc) || 0,
      seq: base + index,
    };
    const current = points.get(id);
    if (current && MONOTONIC_FIELDS.has(name) && Number(current.value) > Number(value)) {
      return;
    }
    // Otherwise the last occurrence wins: the list is in delivery order.
    points.set(id, point);
  });
  return points;
}

/** Merge newer points over older ones (same data point: the newer wins). */
export function mergePoints(older, newer) {
  const merged = new Map(older);
  for (const [id, point] of newer) {
    merged.set(id, point);
  }
  return merged;
}

/** The newest value among the given field names (earlier names win ties). */
function lookup(points, ...names) {
  let best;
  for (const name of names) {
    for (const point of points.values()) {
      if (point.name === name && (!best || point.seq > best.seq)) {
        best = point;
      }
    }
  }
  return best?.value;
}

/** Every value of the fields matching `pattern` (e.g. all doors). */
function lookupAll(points, pattern) {
  return [...points.values()].filter((point) => pattern.test(point.name)).map((p) => p.value);
}

function number(value) {
  if (value === undefined) return undefined;
  const parsed = Number(String(value).replace(/s$/i, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boolean(value) {
  if (value === undefined) return undefined;
  const text = value.toLowerCase();
  if (text === 'true' || text === '1') return true;
  if (text === 'false' || text === '0') return false;
  return undefined;
}

function chargingState(points) {
  const current = lookup(points, 'charging_state_report.current_charge_state');
  if (current !== undefined) {
    const label = /^\d+$/.test(current) ? CHARGE_STATES[Number(current)]?.[0] : current;
    const state = CHARGE_STATE_BY_LABEL[label?.toUpperCase()];
    if (state) return state;
  }
  const flat = lookup(points, 'charging_state');
  if (flat && FLAT_CHARGING_STATES[flat.toLowerCase()]) {
    return FLAT_CHARGING_STATES[flat.toLowerCase()];
  }
  const scenario = lookup(points, 'charging_state_report.charging_scenario')?.toUpperCase();
  if (scenario?.endsWith('_ACTIVE')) return 'charging';
  if (scenario?.endsWith('_FINISHED')) return 'chargePurposeReachedAndNotConservationCharging';
  return undefined;
}

function plugged(points) {
  const value = lookup(points, 'plug_state', 'plug_connection_state');
  if (value === undefined) return undefined;
  if (/disconnected/i.test(value)) return false;
  if (/connected/i.test(value)) return true;
  return undefined;
}

/** Minutes left: `remaining_charging_time` (minutes) or a duration like "1800s". */
function remainingChargingTime(points) {
  const minutes = number(lookup(points, 'remaining_charging_time'));
  if (minutes !== undefined) return Math.round(minutes);
  const raw = lookup(points, 'battery_state_report.remaining_charging_time_complete');
  if (raw === undefined) return undefined;
  const value = number(raw);
  if (value === undefined) return undefined;
  return /s$/i.test(raw) ? Math.round(value / 60) : Math.round(value);
}

function outsideTemperature(points) {
  const celsius = number(
    lookup(points, 'outdoor_temperature', 'outdoor_temperature.outdoor_temperature'),
  );
  if (celsius !== undefined) return Math.round(celsius * 10) / 10;
  // `outside_temperature` is in deci-Kelvin.
  const deciKelvin = number(lookup(points, 'outside_temperature'));
  return deciKelvin === undefined
    ? undefined
    : Math.round((deciKelvin / 10 - KELVIN_OFFSET) * 10) / 10;
}

function anyOpen(points, pattern) {
  const values = lookupAll(points, pattern)
    .map(boolean)
    .filter((v) => v !== undefined);
  return values.length === 0 ? undefined : values.some(Boolean);
}

/**
 * @param {Map} points merged data points (see parseDataset / mergePoints)
 * @returns {object} flat state; every key may be undefined
 */
export function statusFromPoints(points) {
  const state = chargingState(points);
  const odometer = Math.max(
    ...[lookup(points, 'mileage.value'), lookup(points, 'mileage')]
      .map(number)
      .filter((v) => v !== undefined),
  );
  let capturedAt = 0;
  for (const point of points.values()) {
    capturedAt = Math.max(capturedAt, point.timestamp);
  }
  return {
    batteryLevel: number(
      lookup(
        points,
        'battery_state_report.soc',
        'state_of_charge',
        'hv_soc',
        'battery_level_HV.value',
      ),
    ),
    range: number(lookup(points, 'cruising_range_combined', 'cruising_range_primary_engine')),
    chargingState: state,
    charging: state === undefined ? undefined : state === 'charging',
    chargeComplete: state === undefined ? undefined : CHARGE_COMPLETE_STATES.has(state),
    chargePower: number(lookup(points, 'battery_state_report.charge_power', 'charging_power')),
    remainingChargingTime: remainingChargingTime(points),
    targetBatteryLevel: number(lookup(points, 'settings.target_soc')),
    plugged: plugged(points),
    outsideTemperature: outsideTemperature(points),
    odometer: Number.isFinite(odometer) ? odometer : undefined,
    locked: boolean(lookup(points, 'locked')),
    doorsOpen: anyOpen(points, /^doors\.\d+\.open$/),
    windowsOpen: anyOpen(points, /^windows\.\d+\.open$/),
    capturedAt: capturedAt || undefined,
  };
}
