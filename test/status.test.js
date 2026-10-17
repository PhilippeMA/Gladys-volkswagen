import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePoints, parseDataset, statusFromPoints } from '../src/vw/status.js';
import { sampleDataset } from './helpers/fakeVolkswagen.js';

const statusOf = (...datasets) =>
  statusFromPoints(
    datasets.reduce(
      (points, dataset, index) => mergePoints(points, parseDataset(dataset, (index + 1) * 1e6)),
      new Map(),
    ),
  );

test('a complete ID. dataset is normalized', () => {
  const status = statusOf(sampleDataset({ chargeState: 'CHARGE_STATE_CHARGING_HV_BATTERY' }));
  assert.equal(status.batteryLevel, 64, 'read through its GUID despite the generic name');
  assert.equal(status.range, 251);
  assert.equal(status.chargingState, 'charging');
  assert.equal(status.charging, true);
  assert.equal(status.chargeComplete, false);
  assert.equal(status.chargePower, 11);
  assert.equal(status.remainingChargingTime, 95);
  assert.equal(status.targetBatteryLevel, 80);
  assert.equal(status.plugged, true);
  assert.equal(status.odometer, 23456, 'the largest mileage of the snapshots');
  assert.equal(status.outsideTemperature, 12.1, 'deci-Kelvin to Celsius');
  assert.equal(status.locked, true);
  assert.equal(status.doorsOpen, false);
  assert.equal(status.windowsOpen, false);
  assert.equal(status.capturedAt, Date.parse('2026-10-17T08:00:00Z'));
});

test('sentinel values are not readings', () => {
  const status = statusOf(sampleDataset());
  assert.equal(status.remainingChargingTime, undefined, '65535 means no reading');
});

test('a newer dataset wins, an older value stays when the newer lacks it', () => {
  const older = sampleDataset({ soc: 50 });
  const newer = {
    Data: [{ key: '506cb83e-f99f-3af3-bbeb-0429b69a78d9', dataFieldName: 'value', value: '55' }],
  };
  const status = statusOf(older, newer);
  assert.equal(status.batteryLevel, 55);
  assert.equal(status.range, 251, 'kept from the older dataset');
});

test('charge states, by label, by enum index and by fallback fields', () => {
  const one = (name, value) => statusOf({ Data: [{ dataFieldName: name, value }] });
  assert.equal(
    one(
      'charging_state_report.current_charge_state',
      'CHARGE_STATE_CHARGE_PURPOSE_REACHED_AND_CONSERVATION',
    ).chargeComplete,
    true,
  );
  assert.equal(one('charging_state_report.current_charge_state', '3').chargingState, 'charging');
  assert.equal(one('charging_state', 'completed').chargeComplete, true);
  assert.equal(
    one('charging_state_report.charging_scenario', 'CHARGING_SCENARIO_IMMEDIATELY_CHARGING_ACTIVE')
      .charging,
    true,
  );
  assert.equal(
    one('charging_state_report.current_charge_state', 'CHARGE_STATE_INVALID').chargingState,
    undefined,
  );
});

test('plug, doors and temperatures in their other shapes', () => {
  const status = statusOf({
    Data: [
      { dataFieldName: 'plug_connection_state', value: 'disconnected' },
      { dataFieldName: 'doors.0.open', value: 'false' },
      { dataFieldName: 'doors.3.open', value: 'true' },
      { dataFieldName: 'outdoor_temperature', value: '9.46' },
      { dataFieldName: 'battery_state_report.remaining_charging_time_complete', value: '1800s' },
    ],
  });
  assert.equal(status.plugged, false);
  assert.equal(status.doorsOpen, true);
  assert.equal(status.windowsOpen, undefined, 'not reported');
  assert.equal(status.outsideTemperature, 9.5);
  assert.equal(status.remainingChargingTime, 30);
});

test('an empty or malformed dataset gives an empty status', () => {
  const status = statusOf({}, { Data: [null, { dataFieldName: 'x' }] });
  assert.equal(status.batteryLevel, undefined);
  assert.equal(status.odometer, undefined);
  assert.equal(status.capturedAt, undefined);
});
