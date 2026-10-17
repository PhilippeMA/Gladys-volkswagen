import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig } from '../src/config.js';
import { VehicleService } from '../src/vehicles.js';
import { VwClient } from '../src/vw/client.js';
import { VEHICLE_STATUS_WIDGET, WIDGETS, refreshWidgets } from '../src/widgets.js';
import { createFakeVolkswagen, sampleDataset } from './helpers/fakeVolkswagen.js';

const widget = WIDGETS[VEHICLE_STATUS_WIDGET];
const config = normalizeConfig({ email: 'driver@example.com', password: 'secret-password' });

async function setup(content, { read = true } = {}) {
  const vw = createFakeVolkswagen({
    datasets: [{ name: 'a.zip', createdOn: '2026-10-17T08:00:00Z', content }],
  });
  const gladys = createFakeGladys();
  const service = new VehicleService(gladys, {
    createClient: (c) => new VwClient({ email: c.email, password: c.password, fetch: vw.fetch }),
  });
  service.configure(config);
  await service.loadVehicles();
  if (read) {
    await service.refreshStatus(service.vehicles[0]);
  }
  const getContent = (settings = {}) =>
    widget.get(gladys, { settings, language: 'en', units: 'metric', service });
  return { vw, gladys, service, getContent };
}

for (const [label, content, read] of [
  ['idle', sampleDataset(), true],
  ['charging', sampleDataset({ chargeState: 'CHARGE_STATE_CHARGING_HV_BATTERY' }), true],
  ['open door', sampleDataset({ doorOpen: true, locked: false, plug: 'disconnected' }), true],
  ['not yet read', sampleDataset(), false],
]) {
  test(`the ${label} content is rendered exactly as sent`, async () => {
    const { getContent } = await setup(content, { read });
    assert.deepEqual(validateWidgetContent(await getContent()), []);
  });
}

test('the tiles are bound to the published features, without controls', async () => {
  const { service, getContent } = await setup(sampleDataset());
  const featureIds = new Set(
    service.discoveredDevices().flatMap((device) => device.features.map((f) => f.external_id)),
  );
  const content = await getContent();
  const bound = content.components.filter((c) => c.device_feature);
  assert.equal(bound.length, 2, 'battery and range');
  for (const component of bound) {
    assert.ok(featureIds.has(component.device_feature), `unknown ${component.device_feature}`);
    assert.notEqual(component.type, 'button', 'the portal takes no command');
  }
});

test('the chosen car is shown, and an empty account says so', async () => {
  const { service, getContent } = await setup(sampleDataset());
  const [device] = service.discoveredDevices();
  const content = await getContent({ vehicle: device.external_id });
  assert.equal(content.components[0].text, 'Ma ID.3');

  service.vehicles = [];
  const empty = await getContent();
  assert.deepEqual(validateWidgetContent(empty), []);
  assert.equal(empty.components[0].type, 'text');
});

test('the refresh button checks the portal now', async () => {
  const { vw, gladys, service, getContent } = await setup(sampleDataset());
  const button = (await getContent()).components.find((c) => c.action);
  const before = vw.count('/list');
  const message = await widget.action(gladys, {
    actionKey: button.action.key,
    params: button.action.params,
    settings: {},
    service,
  });
  assert.equal(vw.count('/list'), before + 1);
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
