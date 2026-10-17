import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_POLL_FREQUENCIES } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig } from '../src/config.js';
import { createActions } from '../src/actions.js';
import { CHARGING_COMPLETED_TRIGGER, FEATURES, vehicleIds } from '../src/devices/vehicle.js';
import { VehicleService, isChargeCompletion } from '../src/vehicles.js';
import { VwClient } from '../src/vw/client.js';
import {
  VIN,
  createFakeVolkswagen,
  sampleStatus,
  sampleVehicle,
} from './helpers/fakeVolkswagen.js';

const config = normalizeConfig({ email: 'driver@example.com', password: 'secret-password' });

// A service wired to a fake Gladys and a fake Volkswagen, with a hand clock.
async function setup({ vw = createFakeVolkswagen(), cfg = config } = {}) {
  const clock = { now: Date.now() };
  const gladys = createFakeGladys();
  const service = new VehicleService(gladys, {
    createClient: (c) => new VwClient({ email: c.email, password: c.password, fetch: vw.fetch }),
    now: () => clock.now,
  });
  service.configure(cfg);
  await service.loadVehicles();
  const device = service.discoveredDevices()[0];
  const feature = (key) => device?.features.find((f) => f.external_id.endsWith(`:${key}`));
  return { vw, gladys, service, device, feature, clock };
}

test('one device per car, keyed on the VIN, that Gladys accepts', async () => {
  const { gladys, service, device } = await setup();
  assert.equal(device.external_id, vehicleIds(gladys, VIN).device);
  assert.equal(device.name, 'Ma ID.3');
  assert.equal(device.should_poll, true);
  assert.equal(device.poll_frequency, DEVICE_POLL_FREQUENCIES.EVERY_MINUTES);
  assert.equal(device.features.length, FEATURES.length);
  // The SDK fake refuses what the host API refuses (category, unit...).
  await gladys.publishDiscoveredDevices(service.discoveredDevices());
  assert.equal(gladys.fake.discoveredDevices.length, 1);
});

test('features follow the capabilities of the car', async () => {
  const vw = createFakeVolkswagen({
    vehicles: [
      sampleVehicle({
        nickname: null,
        capabilities: [
          { id: 'charging', status: [] },
          { id: 'climatisation', status: [1003] },
        ],
      }),
    ],
  });
  const { device } = await setup({ vw });
  assert.equal(device.name, 'Volkswagen ID.3');
  const keys = device.features.map((f) => f.external_id.split(':').pop());
  assert.ok(keys.includes('battery-level'));
  assert.ok(!keys.includes('climatisation'), 'no switch for a disabled capability');
  assert.ok(!keys.includes('locked'));
});

test('a poll publishes the status, then waits for the configured interval', async () => {
  const { vw, gladys, service, device, feature, clock } = await setup();
  assert.equal(await service.poll(device), true);
  assert.equal(gladys.fake.lastState(feature('battery-level').external_id), 64);
  assert.equal(gladys.fake.lastState(feature('range').external_id), 251);
  assert.equal(gladys.fake.lastState(feature('plugged').external_id), 1);
  assert.equal(gladys.fake.lastState(feature('locked').external_id), 1);
  assert.equal(gladys.fake.lastState(feature('outside-temperature').external_id), 12);

  const reads = () => vw.requests.filter((r) => r.path.includes('selectivestatus')).length;
  clock.now += 60_000;
  assert.equal(await service.poll(device), false, 'not due after a minute');
  clock.now += 240_000;
  assert.equal(await service.poll(device), true, 'due after 300 s');
  assert.equal(reads(), 2);
});

test('only the changed values are published again', async () => {
  const { gladys, service, device, clock } = await setup();
  await service.poll(device);
  const published = gladys.fake.states.length;
  clock.now += 300_000;
  await service.poll(device);
  assert.equal(gladys.fake.states.length, published, 'nothing changed, nothing sent');
});

test('a failed read waits for the next interval too', async () => {
  const { vw, service, device, clock } = await setup();
  vw.statusCode = 429;
  await assert.rejects(service.poll(device));
  clock.now += 60_000;
  assert.equal(await service.poll(device), false);
});

test('commands reach Volkswagen and show the requested value', async () => {
  const { vw, gladys, service, device, feature, clock } = await setup();
  await service.poll(device);

  await service.setValue(device, feature('charging'), 1);
  await service.setValue(device, feature('climatisation'), 1);
  await service.setValue(device, feature('target-battery-level'), 87);
  await service.setValue(device, feature('target-temperature'), 22.3);
  const sent = vw.commands().map((r) => [r.path.split(`${VIN}/`)[1], JSON.parse(r.body)]);
  assert.deepEqual(sent, [
    ['charging/start', {}],
    ['climatisation/start', { targetTemperature: 21.5, targetTemperatureUnit: 'celsius' }],
    ['charging/settings', { targetSOC_pct: 90, maxChargeCurrentAC: 'maximum' }],
    ['climatisation/settings', { targetTemperature: 22.5, targetTemperatureUnit: 'celsius' }],
  ]);
  assert.equal(gladys.fake.lastState(feature('charging').external_id), 1);
  assert.equal(gladys.fake.lastState(feature('target-battery-level').external_id), 90);

  // The car is read again soon, to confirm.
  clock.now += 50_000;
  assert.equal(await service.poll(device), true);
});

test('locking needs the S-PIN', async () => {
  const { vw, service, device, feature } = await setup();
  await assert.rejects(service.setValue(device, feature('locked'), 0), /S-PIN/);
  assert.equal(vw.commands().length, 0);

  service.configure({ ...config, spin: '1234' });
  await service.setValue(device, feature('locked'), 0);
  const [unlock] = vw.commands();
  assert.match(unlock.path, /access\/unlock$/);
  assert.deepEqual(JSON.parse(unlock.body), { spin: '1234' });
});

test('read-only features refuse commands', async () => {
  const { service, device, feature } = await setup();
  await assert.rejects(
    service.setValue(device, feature('battery-level'), 50),
    /cannot be controlled/,
  );
});

test('a completed charge fires the scene trigger once', async () => {
  const { vw, gladys, service, device, clock } = await setup();
  vw.status = sampleStatus({ chargingState: 'charging', soc: 79 });
  await service.poll(device);
  assert.equal(gladys.fake.sceneEvents.length, 0);

  vw.status = sampleStatus({ chargingState: 'chargePurposeReachedAndConservation', soc: 80 });
  clock.now += 300_000;
  await service.poll(device);
  clock.now += 300_000;
  await service.poll(device);
  assert.deepEqual(gladys.fake.sceneEvents, [
    {
      key: CHARGING_COMPLETED_TRIGGER,
      data: { device: device.external_id, battery_level: 80, range: 251 },
    },
  ]);
});

test('a charge stopped before its target is not a completion', () => {
  const charging = { charging: true };
  assert.equal(
    isChargeCompletion(charging, { charging: false, batteryLevel: 60, targetBatteryLevel: 80 }),
    false,
  );
  assert.equal(
    isChargeCompletion(charging, { charging: false, batteryLevel: 80, targetBatteryLevel: 80 }),
    true,
  );
  assert.equal(isChargeCompletion(undefined, { charging: false, chargeComplete: true }), false);
});

test('a refused account is shown in the Configuration screen', async () => {
  const vw = createFakeVolkswagen({ password: 'the-real-one' });
  const gladys = createFakeGladys();
  const service = new VehicleService(gladys, {
    createClient: (c) => new VwClient({ email: c.email, password: c.password, fetch: vw.fetch }),
  });
  service.configure(config);
  await assert.rejects(service.loadVehicles());
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.fr, /mot de passe/);
});

test('without credentials, nothing is sent to Volkswagen', async () => {
  const gladys = createFakeGladys();
  const service = new VehicleService(gladys, {
    createClient: () => assert.fail('no client without credentials'),
  });
  service.configure(normalizeConfig());
  assert.deepEqual(await service.loadVehicles(), []);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  const message = await createActions(service).test_connection();
  assert.ok(message.en.includes('Enter'));
});

test('the actions test the account and wake a car up', async () => {
  const { vw, service, device } = await setup();
  const actions = createActions(service);
  assert.match((await actions.test_connection()).en, /Ma ID\.3/);
  assert.match((await actions.wake_up({ device: device.external_id })).fr, /se réveille/);
  assert.match(vw.commands().at(-1).path, /vehiclewakeuptrigger$/);
});

test('new credentials start a new session', async () => {
  const { service } = await setup();
  assert.equal(service.configure({ ...config, poll_frequency: 600 }), false);
  assert.equal(service.vehicles.length, 1, 'same account: the cars are kept');
  assert.equal(service.configure({ ...config, email: 'other@example.com' }), true);
  assert.equal(service.vehicles.length, 0);
});
