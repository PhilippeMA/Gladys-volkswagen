import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_JOBS } from '../src/vw/client.js';
import { hasCapability, jobsFor, normalizeStatus } from '../src/vw/status.js';
import { sampleStatus, sampleVehicle } from './helpers/fakeVolkswagen.js';

test('a complete ID. status is normalized', () => {
  const status = normalizeStatus(sampleStatus({ chargingState: 'charging' }));
  assert.equal(status.batteryLevel, 64);
  assert.equal(status.range, 251);
  assert.equal(status.batteryTemperature, 19);
  assert.equal(status.charging, true);
  assert.equal(status.chargeComplete, false);
  assert.equal(status.chargePower, 11);
  assert.equal(status.remainingChargingTime, 95);
  assert.equal(status.targetBatteryLevel, 80);
  assert.equal(status.plugged, true);
  assert.equal(status.climatisationOn, false);
  assert.equal(status.targetTemperature, 21.5);
  assert.equal(status.odometer, 23456);
  assert.equal(status.outsideTemperature, 12);
  assert.equal(status.locked, true);
  assert.equal(status.doorsOpen, false);
  assert.equal(status.windowsOpen, false);
  assert.equal(status.online, true);
  assert.equal(status.inspectionDueDays, 120);
});

test('missing or failed jobs leave the values undefined', () => {
  const status = normalizeStatus({
    charging: { error: { message: 'vehicle asleep' } },
    measurements: {
      fuelLevelStatus: { value: { currentSOC_pct: 42 } },
      rangeStatus: { value: { electricRange: 180, totalRange_km: 180 } },
    },
  });
  assert.equal(status.batteryLevel, 42, 'falls back on measurements');
  assert.equal(status.range, 180);
  assert.equal(status.charging, undefined);
  assert.equal(status.plugged, undefined);
  assert.equal(status.locked, undefined);
  assert.deepEqual(normalizeStatus(undefined).batteryLevel, undefined);
});

test('an open door or window is detected', () => {
  const raw = sampleStatus();
  raw.access.accessStatus.value.doors[0].status = ['unlocked', 'open'];
  raw.access.accessStatus.value.doorLockStatus = 'unlocked';
  const status = normalizeStatus(raw);
  assert.equal(status.doorsOpen, true);
  assert.equal(status.locked, false);
});

test('climatisation states other than off mean on', () => {
  for (const state of ['heating', 'cooling', 'ventilation']) {
    assert.equal(
      normalizeStatus(sampleStatus({ climatisationState: state })).climatisationOn,
      true,
    );
  }
});

test('only the enabled capabilities are asked for', () => {
  const vehicle = sampleVehicle({
    capabilities: [
      { id: 'charging', status: [] },
      { id: 'climatisation', status: [1003] }, // licence expired
      { id: 'measurements' },
    ],
  });
  assert.deepEqual(jobsFor(vehicle, STATUS_JOBS), ['charging', 'measurements']);
  assert.equal(hasCapability(vehicle, 'climatisation'), false);
  assert.equal(hasCapability(vehicle, 'charging'), true);
  // Without a capability list, everything is asked for.
  assert.deepEqual(jobsFor({ vin: 'x' }, STATUS_JOBS), STATUS_JOBS);
  assert.equal(hasCapability({ vin: 'x' }, 'access'), true);
});
