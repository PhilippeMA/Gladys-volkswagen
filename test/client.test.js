import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { VwAuthError } from '../src/vw/auth.js';
import {
  NoDataRequestError,
  VwClient,
  describeShape,
  findImageLocation,
} from '../src/vw/client.js';
import { readJsonFromZip } from '../src/vw/zip.js';
import {
  CAR_IMAGE_PATH,
  CAR_PNG,
  VIN,
  createFakeVolkswagen,
  sampleDataset,
  zipJson,
} from './helpers/fakeVolkswagen.js';

const credentials = { email: 'driver@example.com', password: 'secret-password' };

test('lists the cars linked to the portal, signing in once', async () => {
  const vw = createFakeVolkswagen();
  const client = new VwClient({ ...credentials, fetch: vw.fetch });
  const [vehicles] = await Promise.all([client.getVehicles(), client.getVehicles()]);
  assert.equal(vehicles.length, 1);
  const [vehicle] = vehicles;
  assert.equal(vehicle.vin, VIN);
  assert.equal(vehicle.nickname, 'Ma ID.3');
  assert.equal(vehicle.model, 'ID.3');
  assert.equal(vehicle.image, `https://eu-data-act.drivesomethinggreater.com${CAR_IMAGE_PATH}`);
  assert.equal(vw.logins, 1, 'concurrent calls share one sign-in');
});

test('reads the data request, lists and downloads the datasets', async () => {
  const vw = createFakeVolkswagen();
  const client = new VwClient({ ...credentials, fetch: vw.fetch });
  const identifier = await client.getDataRequest(VIN);
  const list = await client.listDatasets(VIN, identifier);
  assert.equal(list.length, 1, 'the "no content" placeholder is left out');
  const dataset = await client.downloadDataset(VIN, identifier, list[0].name);
  assert.equal(dataset.vin, VIN);
  assert.ok(dataset.Data.length > 5);
});

test('a car without data request is reported as such', async () => {
  const vw = createFakeVolkswagen({ dataRequest: false });
  const client = new VwClient({ ...credentials, fetch: vw.fetch });
  await assert.rejects(client.getDataRequest(VIN), NoDataRequestError);
});

test('no dataset yet is an empty list, not an error', async () => {
  const vw = createFakeVolkswagen({ datasets: [] });
  const client = new VwClient({ ...credentials, fetch: vw.fetch });
  assert.deepEqual(await client.listDatasets(VIN, 'req-1'), []);
});

for (const expiredAnswer of [401, 500]) {
  test(`an expired session (HTTP ${expiredAnswer}) signs in again, once`, async () => {
    const vw = createFakeVolkswagen();
    vw.expiredAnswer = expiredAnswer;
    const client = new VwClient({ ...credentials, fetch: vw.fetch });
    await client.getVehicles();
    vw.expireSessions();
    await client.getVehicles();
    assert.equal(vw.logins, 2);
  });
}

test('a refused sign-in is not retried for a while (account lock-out)', async () => {
  let now = Date.now();
  const vw = createFakeVolkswagen();
  const client = new VwClient({
    ...credentials,
    password: 'wrong',
    fetch: vw.fetch,
    now: () => now,
  });
  await assert.rejects(client.getVehicles(), VwAuthError);
  const attempts = vw.requests.length;
  await assert.rejects(client.getVehicles(), VwAuthError);
  assert.equal(vw.requests.length, attempts, 'no new attempt within the delay');
  now += 16 * 60 * 1000;
  await assert.rejects(client.getVehicles(), VwAuthError);
  assert.ok(vw.requests.length > attempts, 'tried again after the delay');
});

test('the ZIP reader handles deflated and stored entries', () => {
  const document = sampleDataset();
  assert.deepEqual(readJsonFromZip(zipJson(document)), document);

  // A stored (uncompressed) entry preceded by another file.
  const entry = (name, content, method) => {
    const data = method === 8 ? zlib.deflateRawSync(content) : content;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt16LE(Buffer.byteLength(name), 26);
    return Buffer.concat([header, Buffer.from(name), data]);
  };
  const archive = Buffer.concat([
    entry('readme.txt', Buffer.from('hello'), 0),
    entry('data.json', Buffer.from('﻿{"ok":true}'), 0),
  ]);
  assert.deepEqual(readJsonFromZip(archive), { ok: true });
  assert.throws(() => readJsonFromZip(Buffer.from('not a zip')), /No JSON/);
});

test('downloads the picture of the car with the portal session', async () => {
  const vw = createFakeVolkswagen();
  const client = new VwClient({ ...credentials, fetch: vw.fetch });
  const [vehicle] = await client.getVehicles();
  const { body } = await client.getVehicleImage(vehicle.image);
  assert.deepEqual(body, CAR_PNG);
  // A portal path works too; plain http is refused.
  assert.deepEqual((await client.getVehicleImage(CAR_IMAGE_PATH)).body, CAR_PNG);
  await assert.rejects(client.getVehicleImage('http://example.com/car.png'), /https/);
});

test('the picture location is found in the shapes the portal uses', () => {
  assert.equal(
    findImageLocation({ imageLocation: 'https://cdn.example/a.png' }),
    'https://cdn.example/a.png',
  );
  assert.equal(
    findImageLocation({
      images: [
        { viewPosition: 'REAR', url: 'https://cdn.example/rear.png' },
        { viewPosition: 'FRONT_LEFT', url: 'https://cdn.example/front_left.png' },
      ],
    }),
    'https://cdn.example/front_left.png',
  );
  assert.equal(
    findImageLocation({ relation: { vehicleImage: { uri: '/media/car.jpg' } } }),
    '/media/car.jpg',
  );
  // A field that is not an image, or a value that is not a location, is ignored.
  assert.equal(findImageLocation({ licensePlate: 'AB-123-CD', imageLocation: '' }), undefined);
  assert.equal(findImageLocation({ image: 'front left' }), undefined);
  assert.equal(findImageLocation(undefined), undefined);
});

test('the logged shape of an answer holds field names, never values', () => {
  const shape = describeShape({
    vin: VIN,
    nickName: 'Ma ID.3',
    relation: { role: 'PRIMARY_USER', images: [{ url: 'https://x' }] },
    list: [],
  });
  assert.deepEqual(shape, ['vin', 'nickName', 'relation.role', 'relation.images[].url', 'list[]']);
  assert.ok(!shape.join(' ').includes(VIN));
});

test('reads the relation of the account to a car', async () => {
  const vw = createFakeVolkswagen({ relationImage: '/media/relation.png' });
  const client = new VwClient({ ...credentials, fetch: vw.fetch });
  const relation = await client.getVehicleRelation(VIN);
  assert.equal(findImageLocation(relation), '/media/relation.png');
  assert.equal(await client.getVehicleRelation('WVWZZZE1ZMP000000'), undefined);
});
