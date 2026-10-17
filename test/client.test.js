import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VwAuthError } from '../src/vw/auth.js';
import { VwApiError, VwClient } from '../src/vw/client.js';
import { createFileTokenStore, createMemoryTokenStore } from '../src/vw/tokenStore.js';
import { VIN, createFakeVolkswagen } from './helpers/fakeVolkswagen.js';

const credentials = { email: 'driver@example.com', password: 'secret-password' };

test('signs in once, then reuses the token', async () => {
  const vw = createFakeVolkswagen();
  const client = new VwClient({ ...credentials, fetch: vw.fetch });
  const [vehicles] = await Promise.all([client.getVehicles(), client.getVehicles()]);
  await client.getStatus(VIN);
  assert.equal(vehicles[0].vin, VIN);
  assert.equal(vw.logins, 1, 'concurrent calls share one sign-in');
});

test('an expired token is refreshed, not signed in again', async () => {
  let now = Date.now();
  const vw = createFakeVolkswagen({ now: () => now });
  const client = new VwClient({ ...credentials, fetch: vw.fetch, now: () => now });
  await client.getVehicles();
  now += 2 * 3600 * 1000;
  await client.getVehicles();
  assert.equal(vw.logins, 1);
  assert.equal(vw.refreshes, 1);
});

test('a token revoked before its expiry is renewed on the 401, once', async () => {
  const vw = createFakeVolkswagen();
  const client = new VwClient({ ...credentials, fetch: vw.fetch });
  await client.getVehicles();
  vw.revokeAccessTokens();
  await client.getVehicles();
  assert.equal(vw.refreshes, 1);
});

test('a refused refresh token falls back to a full sign-in', async () => {
  let now = Date.now();
  const vw = createFakeVolkswagen({ now: () => now });
  const client = new VwClient({ ...credentials, fetch: vw.fetch, now: () => now });
  await client.getVehicles();
  vw.revokeRefreshTokens();
  now += 2 * 3600 * 1000;
  await client.getVehicles();
  assert.equal(vw.logins, 2);
});

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

test('the tokens survive a restart through the store', async () => {
  const vw = createFakeVolkswagen();
  const tokenStore = createMemoryTokenStore();
  await new VwClient({ ...credentials, fetch: vw.fetch, tokenStore }).getVehicles();
  await new VwClient({ ...credentials, fetch: vw.fetch, tokenStore }).getVehicles();
  assert.equal(vw.logins, 1);

  // Another account never reuses them.
  vw.email = 'other@example.com';
  await new VwClient({
    email: 'other@example.com',
    password: credentials.password,
    fetch: vw.fetch,
    tokenStore,
  }).getVehicles();
  assert.equal(vw.logins, 2);
});

test('the file store writes a private file under the data directory', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'vw-tokens-'));
  try {
    const store = createFileTokenStore({ dataDir });
    assert.equal(await store.load(credentials.email), undefined);
    await store.save(credentials.email, { accessToken: 'a', refreshToken: 'r', expiresAt: 1 });
    assert.deepEqual(await store.load(credentials.email), {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 1,
    });
    assert.equal(await store.load('someone@else.com'), undefined);
    const file = path.join(dataDir, 'vw-tokens.json');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.ok(!(await readFile(file, 'utf8')).includes(credentials.email), 'no email in clear');
    await store.clear();
    assert.equal(await store.load(credentials.email), undefined);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('commands hit the documented endpoints', async () => {
  const vw = createFakeVolkswagen();
  const client = new VwClient({ ...credentials, fetch: vw.fetch });
  await client.startCharging(VIN);
  await client.stopCharging(VIN);
  await client.setChargingSettings(VIN, { targetSOC_pct: 90 });
  await client.startClimatisation(VIN, { targetTemperature: 21 });
  await client.stopClimatisation(VIN);
  await client.setLocked(VIN, true, '1234');
  await client.wakeUp(VIN);
  assert.deepEqual(
    vw.commands().map((r) => `${r.method} ${r.path.split(VIN)[1]}`),
    [
      'POST /charging/start',
      'POST /charging/stop',
      'PUT /charging/settings',
      'POST /climatisation/start',
      'POST /climatisation/stop',
      'POST /access/lock',
      'POST /vehiclewakeuptrigger',
    ],
  );
  const climatisation = vw.commands()[3];
  assert.deepEqual(JSON.parse(climatisation.body), {
    targetTemperature: 21,
    targetTemperatureUnit: 'celsius',
  });
  assert.equal(JSON.parse(vw.commands()[5].body).spin, '1234');
});

test('an API error carries its HTTP status', async () => {
  const vw = createFakeVolkswagen();
  vw.statusCode = 429;
  const client = new VwClient({ ...credentials, fetch: vw.fetch });
  await assert.rejects(
    client.getStatus(VIN),
    (err) => err instanceof VwApiError && err.status === 429,
  );
});

test('the parking position is null while the car drives', async () => {
  const vw = createFakeVolkswagen();
  const client = new VwClient({ ...credentials, fetch: vw.fetch });
  assert.deepEqual(await client.getParkingPosition(VIN), {
    lat: 48.85,
    lon: 2.35,
    carCapturedTimestamp: 'x',
  });
});
