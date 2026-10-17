import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig } from '../src/config.js';
import { VehicleService } from '../src/vehicles.js';
import { VwClient } from '../src/vw/client.js';
import { VEHICLE_STATUS_WIDGET, WIDGETS, refreshWidgets } from '../src/widgets.js';
import { createFakeVolkswagen, sampleStatus } from './helpers/fakeVolkswagen.js';

const widget = WIDGETS[VEHICLE_STATUS_WIDGET];
const config = normalizeConfig({ email: 'driver@example.com', password: 'secret-password' });

async function setup(status) {
  const vw = createFakeVolkswagen({ status });
  const gladys = createFakeGladys();
  const service = new VehicleService(gladys, {
    createClient: (c) => new VwClient({ email: c.email, password: c.password, fetch: vw.fetch }),
  });
  service.configure(config);
  await service.loadVehicles();
  await service.refreshStatus(service.vehicles[0]);
  const getContent = (settings = {}) =>
    widget.get(gladys, { settings, language: 'en', units: 'metric', service });
  return { vw, gladys, service, getContent };
}

for (const [label, status] of [
  ['idle', sampleStatus()],
  ['charging', sampleStatus({ chargingState: 'charging' })],
  ['climatising', sampleStatus({ climatisationState: 'heating', plug: 'disconnected' })],
]) {
  test(`the ${label} content is rendered exactly as sent`, async () => {
    const { getContent } = await setup(status);
    assert.deepEqual(validateWidgetContent(await getContent()), []);
  });
}

test('the tiles and buttons are bound to the published features', async () => {
  const { service, getContent } = await setup(sampleStatus({ chargingState: 'charging' }));
  const featureIds = new Set(
    service.discoveredDevices().flatMap((device) => device.features.map((f) => f.external_id)),
  );
  const content = await getContent();
  const bound = content.components.filter((c) => c.device_feature);
  assert.equal(bound.length, 4, 'battery, range, climatisation and charging');
  for (const component of bound) {
    assert.ok(featureIds.has(component.device_feature), `unknown ${component.device_feature}`);
  }
  const charge = bound.find((c) => c.device_feature.endsWith(':charging'));
  assert.equal(charge.value, 0, 'a charging car offers to stop');
});

test('the chosen car is shown, and an empty account says so', async () => {
  const { service, getContent } = await setup(sampleStatus());
  const [device] = service.discoveredDevices();
  const content = await getContent({ vehicle: device.external_id });
  assert.equal(content.components[0].text, 'Ma ID.3');

  service.vehicles = [];
  const empty = await getContent();
  assert.deepEqual(validateWidgetContent(empty), []);
  assert.equal(empty.components[0].type, 'text');
});

test('the refresh button reads the car now', async () => {
  const { vw, gladys, service, getContent } = await setup(sampleStatus());
  const button = (await getContent()).components.find((c) => c.action);
  const reads = () => vw.requests.filter((r) => r.path.includes('selectivestatus')).length;
  const before = reads();
  const message = await widget.action(gladys, {
    actionKey: button.action.key,
    params: button.action.params,
    settings: {},
    service,
  });
  assert.equal(reads(), before + 1);
  assert.ok(message.en.length <= 200);
  await assert.rejects(
    widget.action(gladys, { actionKey: 'unknown', params: {}, settings: {}, service }),
    /Unknown widget action/,
  );
});

test('refreshWidgets nudges every widget', () => {
  const fresh = createFakeGladys();
  refreshWidgets(fresh);
  assert.deepEqual(fresh.fake.widgetRefreshes, Object.keys(WIDGETS));
});
