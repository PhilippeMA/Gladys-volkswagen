import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_POLL_FREQUENCIES } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig } from '../src/config.js';
import { createActions } from '../src/actions.js';
import { CHARGING_COMPLETED_TRIGGER, FEATURES, vehicleIds } from '../src/devices/vehicle.js';
import { VehicleService, isChargeCompletion } from '../src/vehicles.js';
import { VwClient } from '../src/vw/client.js';
import { CAR_PNG, VIN, createFakeVolkswagen, sampleDataset } from './helpers/fakeVolkswagen.js';

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

test('one read-only device per car, keyed on the VIN, that Gladys accepts', async () => {
  const { gladys, service, device } = await setup();
  assert.equal(device.external_id, vehicleIds(gladys, VIN).device);
  assert.equal(device.name, 'Ma ID.3');
  assert.equal(device.should_poll, true);
  assert.equal(device.poll_frequency, DEVICE_POLL_FREQUENCIES.EVERY_MINUTES);
  assert.equal(device.features.length, FEATURES.length);
  assert.ok(
    device.features.every((f) => f.read_only),
    'the portal takes no command',
  );
  // The SDK fake refuses what the host API refuses (category, unit...).
  await gladys.publishDiscoveredDevices(service.discoveredDevices());
  assert.equal(gladys.fake.discoveredDevices.length, 1);
});

test('a poll publishes the dataset, then waits for the configured interval', async () => {
  const { vw, gladys, service, device, feature, clock } = await setup();
  assert.equal(await service.poll(device), true);
  assert.equal(gladys.fake.lastState(feature('battery-level').external_id), 64);
  assert.equal(gladys.fake.lastState(feature('range').external_id), 251);
  assert.equal(gladys.fake.lastState(feature('plugged').external_id), 1);
  assert.equal(gladys.fake.lastState(feature('locked').external_id), 1);
  assert.equal(gladys.fake.lastState(feature('odometer').external_id), 23456);
  assert.equal(gladys.fake.lastState(feature('outside-temperature').external_id), 12.1);
  assert.equal(gladys.fake.lastState(feature('remaining-charging-time').external_id), undefined);

  clock.now += 60_000;
  assert.equal(await service.poll(device), false, 'not due after a minute');
  clock.now += 240_000;
  assert.equal(await service.poll(device), true, 'due after 300 s');
  assert.equal(vw.count('/download'), 1, 'a dataset is downloaded once');
});

test('only the new datasets are downloaded and merged', async () => {
  const { vw, gladys, service, device, feature, clock } = await setup();
  await service.poll(device);
  vw.deliver(
    {
      Data: [{ key: '506cb83e-f99f-3af3-bbeb-0429b69a78d9', dataFieldName: 'value', value: '70' }],
    },
    '2026-10-17T08:15:00Z',
  );
  clock.now += 300_000;
  await service.poll(device);
  assert.equal(vw.count('/download'), 2);
  assert.equal(gladys.fake.lastState(feature('battery-level').external_id), 70);
  assert.equal(gladys.fake.lastState(feature('range').external_id), 251, 'kept from before');
});

test('the first read merges the newest datasets only', async () => {
  const datasets = Array.from({ length: 10 }, (_, i) => ({
    name: `request_${i}.zip`,
    createdOn: new Date(Date.UTC(2026, 9, 17, 8, i * 15)).toISOString(),
    content: sampleDataset({ soc: 50 + i }),
  }));
  const { vw, gladys, service, device, feature } = await setup({
    vw: createFakeVolkswagen({ datasets }),
  });
  await service.poll(device);
  assert.equal(vw.count('/download'), 4);
  assert.equal(gladys.fake.lastState(feature('battery-level').external_id), 59, 'the newest');
});

test('a car not delivering yet publishes nothing and says so', async () => {
  const { gladys, service, device } = await setup({ vw: createFakeVolkswagen({ datasets: [] }) });
  assert.equal(await service.refreshStatus(service.findVehicle(device.external_id)), undefined);
  assert.equal(gladys.fake.states.length, 0);
  assert.match((await createActions(service).test_connection()).en, /no data yet/);
});

test('a missing data request is shown in the Configuration screen', async () => {
  const { gladys, service, device } = await setup({
    vw: createFakeVolkswagen({ dataRequest: false }),
  });
  await assert.rejects(service.poll(device));
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /continuous data request/);
  assert.match((await createActions(service).test_connection()).fr, /demande de données/);
});

test('a completed charge fires the scene trigger once', async () => {
  const { vw, gladys, service, device, clock } = await setup({
    vw: createFakeVolkswagen({
      datasets: [
        {
          name: 'a.zip',
          createdOn: '2026-10-17T08:00:00Z',
          content: sampleDataset({ chargeState: 'CHARGE_STATE_CHARGING_HV_BATTERY', soc: 79 }),
        },
      ],
    }),
  });
  await service.poll(device);
  assert.equal(gladys.fake.sceneEvents.length, 0);

  vw.deliver(
    sampleDataset({ chargeState: 'CHARGE_STATE_CHARGE_PURPOSE_REACHED_AND_CONSERVATION', soc: 80 }),
    '2026-10-17T08:15:00Z',
  );
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

test('an unreachable portal is shown in the Configuration screen too', async () => {
  const gladys = createFakeGladys();
  const service = new VehicleService(gladys, {
    createClient: (c) =>
      new VwClient({
        email: c.email,
        password: c.password,
        fetch: async () => {
          throw new Error('getaddrinfo ENOTFOUND identity.vwgroup.io');
        },
      }),
  });
  service.configure(config);
  await assert.rejects(service.loadVehicles());
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /ENOTFOUND/);
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

test('the connection test signs in, lists and reads the cars', async () => {
  const { service } = await setup();
  assert.match((await createActions(service).test_connection()).en, /Ma ID\.3.*Discovery/);
});

test('new credentials start a new session', async () => {
  const { service } = await setup();
  assert.equal(service.configure({ ...config, poll_frequency: 600 }), false);
  assert.equal(service.vehicles.length, 1, 'same account: the cars are kept');
  assert.equal(service.configure({ ...config, email: 'other@example.com' }), true);
  assert.equal(service.vehicles.length, 0);
});

test('the name shown is the one given to the device in Gladys', async () => {
  const vw = createFakeVolkswagen();
  const gladys = createFakeGladys();
  const externalId = vehicleIds(gladys, VIN).device;
  gladys.fake.devices.push({ external_id: externalId, name: 'Voiture de Philippe', features: [] });
  await gladys.connect();
  const service = new VehicleService(gladys, {
    createClient: (c) => new VwClient({ email: c.email, password: c.password, fetch: vw.fetch }),
  });
  service.configure(config);
  const [vehicle] = await service.loadVehicles();
  assert.equal(service.displayName(vehicle), 'Voiture de Philippe');

  await gladys.fake.deviceUpdated({ external_id: externalId, name: '  ', features: [] });
  assert.equal(service.displayName(vehicle), 'Ma ID.3', 'the app nickname until named');
});

test('the car picture is downloaded once, and served by its key', async () => {
  const { vw, service } = await setup();
  const [vehicle] = service.vehicles;
  const picture = await service.vehiclePicture(vehicle);
  assert.match(picture.key, /^vw-[0-9a-f]{24}$/);
  assert.equal(await service.pictureByKey(picture.key), CAR_PNG.toString('base64'));
  await service.vehiclePicture(vehicle);
  assert.equal(vw.count('/front_left.png'), 1);
  await assert.rejects(service.pictureByKey('vw-unknown'), /Unknown picture/);
});

test('a picture unfit for a widget is left out, and retried an hour later', async () => {
  const vw = createFakeVolkswagen({ carImage: Buffer.from('<html>not an image</html>') });
  const { service, clock } = await setup({ vw });
  const [vehicle] = service.vehicles;
  assert.equal(await service.vehiclePicture(vehicle), undefined);
  assert.equal(await service.vehiclePicture(vehicle), undefined);
  assert.equal(vw.count('/front_left.png'), 1, 'not on every dashboard refresh');
  vw.carImage = CAR_PNG;
  clock.now += 61 * 60 * 1000;
  assert.ok(await service.vehiclePicture(vehicle));
});

test('a car without picture on the portal has none, and the answers are looked up once', async () => {
  const vw = createFakeVolkswagen({ vehicles: [{ vin: VIN, nickName: 'Ma ID.3' }] });
  const { service } = await setup({ vw });
  assert.equal(await service.vehiclePicture(service.vehicles[0]), undefined);
  assert.equal(await service.vehiclePicture(service.vehicles[0]), undefined);
  assert.equal(vw.count('.png'), 0);
  assert.equal(vw.count('/relations/'), 1, 'not on every dashboard refresh');
});

test('without a picture in the vehicle list, the relation one is used', async () => {
  const vw = createFakeVolkswagen({
    vehicles: [{ vin: VIN, nickName: 'Ma ID.3' }],
    relationImage: '/media/relation.png',
  });
  const { service } = await setup({ vw });
  const picture = await service.vehiclePicture(service.vehicles[0]);
  assert.ok(picture, 'found in the relation');
  assert.equal(picture.base64, CAR_PNG.toString('base64'));
});
