// -----------------------------------------------------------------------------
// An in-memory Volkswagen: the identity provider (identity.vwgroup.io) and the
// EU Data Act portal, served through a `fetch` replacement. Tests never touch
// the network.
//
// The fake checks what the real sites need: the session cookies hop to hop,
// the CSRF / hmac values of the forms, the portal cookie on every API call.
// -----------------------------------------------------------------------------

import zlib from 'node:zlib';

export const VIN = 'WVWZZZE1ZMP012345';
const CLIENT = '9b58543e-1c15-4193-91d5-8a14145bebb0@apps_vw-dilab_com';
const IDENTITY = 'https://identity.vwgroup.io';
const PORTAL = 'https://eu-data-act.drivesomethinggreater.com';

/** A dataset of the portal, as its JSON document. */
export function sampleDataset({
  soc = 64,
  range = 251,
  chargeState = 'CHARGE_STATE_READY_FOR_CHARGING',
  plug = 'connected',
  targetSoc = 80,
  locked = true,
  doorOpen = false,
  at = '2026-10-17T08:00:00Z',
} = {}) {
  const point = (dataFieldName, value, key) => ({
    key: key ?? `${dataFieldName}-key`,
    dataFieldName,
    value: String(value),
    timestampUtc: at,
  });
  return {
    vin: VIN,
    Data: [
      // The ID.3 soc arrives under a generic name: only its GUID tells.
      point('value', soc, '506cb83e-f99f-3af3-bbeb-0429b69a78d9'),
      point('cruising_range_combined', range, '153e8c40-4c6c-3c17-a11b-0ecc35d55b81'),
      point('charging_state_report.current_charge_state', chargeState),
      point(
        'battery_state_report.charge_power',
        chargeState === 'CHARGE_STATE_CHARGING_HV_BATTERY' ? 11 : 0,
      ),
      point(
        'remaining_charging_time',
        chargeState === 'CHARGE_STATE_CHARGING_HV_BATTERY' ? 95 : 65535,
      ),
      point('charging_plug1_connectionstate', plug),
      point('settings.target_soc', targetSoc),
      // A dataset mixes snapshots: the larger mileage is the current one.
      point('mileage.value', 23450, 'mileage-a'),
      point('mileage.value', 23456, 'mileage-b'),
      point('outside_temperature', 2852),
      point('locked', locked),
      point('doors.0.open', doorOpen),
      point('doors.1.open', false),
      point('windows.0.open', false),
    ],
  };
}

/** A ZIP archive holding `document` as JSON (one deflated entry). */
// A valid 1×1 PNG: the picture the fake portal holds for the car.
export const CAR_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
export const CAR_IMAGE_PATH = `/media/vehicles/${VIN}/front_left.png`;

export function zipJson(document, name = 'dataset.json') {
  const data = zlib.deflateRawSync(Buffer.from(JSON.stringify(document)));
  const fileName = Buffer.from(name);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(JSON.stringify(document).length, 22);
  header.writeUInt16LE(fileName.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, fileName, data]);
}

function reply(status, { body = '', headers = {}, cookies = [] } = {}) {
  const responseHeaders = new Headers(headers);
  for (const cookie of cookies) {
    responseHeaders.append('set-cookie', cookie);
  }
  let payload = body;
  if (typeof body === 'object' && !Buffer.isBuffer(body)) {
    payload = JSON.stringify(body);
    responseHeaders.set('content-type', 'application/json');
  }
  return new Response(status === 204 ? null : payload, { status, headers: responseHeaders });
}

const redirect = (location, cookies = []) => reply(302, { headers: { location }, cookies });

export function createFakeVolkswagen({
  email = 'driver@example.com',
  password = 'secret-password',
  vehicles = [
    {
      vin: VIN,
      nickName: 'Ma ID.3',
      modelName: 'ID.3',
      imageLocation: `${PORTAL}${CAR_IMAGE_PATH}`,
    },
  ],
  carImage = CAR_PNG,
  datasets = [
    {
      name: 'request_20261017T0800.zip',
      createdOn: '2026-10-17T08:00:00Z',
      content: sampleDataset(),
    },
  ],
  dataRequest = true,
  portalConsent = true,
  marketingConsent = false,
} = {}) {
  const vw = {
    email,
    password,
    vehicles,
    datasets,
    dataRequest,
    portalConsent,
    marketingConsent,
    carImage,
    requests: [],
    logins: 0,
    validSessions: new Set(),
    expiredAnswer: 401,

    /** Add a dataset delivered at `createdOn`. */
    deliver(content, createdOn) {
      this.datasets.push({ name: `request_${createdOn}.zip`, createdOn, content });
    },
    expireSessions() {
      this.validSessions.clear();
    },
    count(pathPart) {
      return this.requests.filter((r) => r.path.includes(pathPart)).length;
    },
  };

  async function handle(url, init) {
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const form = headers.get('content-type')?.includes('form')
      ? new URLSearchParams(init.body)
      : null;
    const cookies = headers.get('cookie') ?? '';
    vw.requests.push({ method, host: url.host, path: url.pathname + url.search, headers });
    const signin = `/signin-service/v1/${CLIENT}`;

    // --- Identity provider -------------------------------------------------
    if (url.origin === IDENTITY && url.pathname === '/oidc/v1/authorize') {
      if (url.searchParams.get('client_id') !== CLIENT) {
        return reply(403, { body: 'tenant misconfiguration' });
      }
      if (url.searchParams.get('redirect_uri') !== `${PORTAL}/login`) {
        return reply(400);
      }
      return redirect(`${signin}?relayState=relay-1`, ['SESSION=idp-session; Path=/; HttpOnly']);
    }
    if (url.origin === IDENTITY && url.pathname === signin) {
      requireCookie(cookies, 'SESSION=idp-session');
      return reply(200, {
        body: `<html><form id="emailPasswordForm" method="POST" action="${signin}/login/identifier">
<input type="hidden" name="_csrf" value="csrf-1"/><input type="hidden" name="relayState" value="relay-1"/>
<input type="hidden" name="hmac" value="hmac-1"/><input type="email" name="email" value=""/></form></html>`,
      });
    }
    if (url.origin === IDENTITY && url.pathname === `${signin}/login/identifier`) {
      requireCookie(cookies, 'SESSION=idp-session');
      if (form.get('_csrf') !== 'csrf-1' || form.get('hmac') !== 'hmac-1') {
        return reply(403);
      }
      const known = form.get('email') === vw.email;
      return reply(303, {
        headers: { location: `${signin}/login/authenticate?relayState=relay-1&known=${known}` },
      });
    }
    if (url.origin === IDENTITY && url.pathname === `${signin}/login/authenticate`) {
      if (method === 'GET') {
        const model = {
          hmac: 'hmac-2',
          relayState: 'relay-1',
          postAction: 'login/authenticate',
          identifierUrl: 'login/identifier',
          emailPasswordForm: { email: vw.email, nested: { ok: true } },
          ...(url.searchParams.get('known') === 'false'
            ? { registerCredentialsPath: 'register' }
            : {}),
          ...(url.searchParams.get('error') ? { error: url.searchParams.get('error') } : {}),
        };
        return reply(200, {
          body: `<html><script>window._IDK = {\n  templateModel: ${JSON.stringify(model)},\n  csrf_token: 'csrf-2',\n};</script></html>`,
        });
      }
      if (form.get('_csrf') !== 'csrf-2' || form.get('hmac') !== 'hmac-2') {
        return reply(403);
      }
      if (form.get('password') !== vw.password) {
        return reply(303, {
          headers: {
            location: `${signin}/login/authenticate?relayState=relay-1&error=login.errors.password_invalid`,
          },
        });
      }
      return redirect(`${IDENTITY}/oidc/v1/oauth/sso?userId=user-1`);
    }
    if (url.origin === IDENTITY && url.pathname === '/oidc/v1/oauth/sso') {
      if (!vw.portalConsent) {
        return redirect(`${IDENTITY}/signin-service/v1/consent/users/user-1?scopes=cars`);
      }
      if (vw.marketingConsent) {
        const callback = `${IDENTITY}/oidc/v1/oauth/client/callback?state=s&user=user-1`;
        return redirect(
          `${IDENTITY}/signin-service/v1/consent/marketing/user-1?callback=${encodeURIComponent(callback)}`,
        );
      }
      return redirect(`${PORTAL}/login?code=auth-code&state=de__en__VOLKSWAGEN_PASSENGER_CARS`);
    }
    if (url.origin === IDENTITY && url.pathname.includes('/consent/marketing/')) {
      throw new Error('the optional marketing consent page must be skipped, not fetched');
    }
    if (url.origin === IDENTITY && url.pathname.includes('/consent/')) {
      return reply(200, { body: '<html>Allow Gladys to use your data? consent-screen</html>' });
    }
    if (url.origin === IDENTITY && url.pathname === '/oidc/v1/oauth/client/callback') {
      return redirect(`${PORTAL}/login?code=auth-code&state=de__en__VOLKSWAGEN_PASSENGER_CARS`);
    }

    // --- Portal ------------------------------------------------------------
    if (url.origin === PORTAL && url.pathname === '/login') {
      if (url.searchParams.get('code') !== 'auth-code') {
        return reply(400);
      }
      return redirect('/services/callbacklogin?step=2', ['login-flow=1; Path=/']);
    }
    if (url.origin === PORTAL && url.pathname === '/services/callbacklogin') {
      vw.logins += 1;
      const session = `session-${vw.logins}`;
      vw.validSessions.add(session);
      return redirect('/de/en/user.html', [`access_token=${session}; Path=/; Secure; HttpOnly`]);
    }
    if (url.origin === PORTAL && url.pathname === CAR_IMAGE_PATH) {
      if (!vw.validSessions.has(cookies.match(/access_token=([^;]+)/)?.[1])) {
        return reply(401);
      }
      return reply(200, { body: vw.carImage, headers: { 'content-type': 'image/png' } });
    }
    if (url.origin === PORTAL && url.pathname.endsWith('/user.html')) {
      throw new Error('the heavy portal landing page must not be fetched');
    }
    if (url.origin === PORTAL && url.pathname.startsWith('/proxy_api/')) {
      const session = cookies.match(/access_token=([^;]+)/)?.[1];
      if (!vw.validSessions.has(session)) {
        return vw.expiredAnswer === 500
          ? reply(500, { body: '<html>AEM error</html>' })
          : reply(401);
      }
      if (url.pathname === '/proxy_api/consent/me/vehicles') {
        return reply(200, { body: vw.vehicles });
      }
      const match = url.pathname.match(/\/vehicles\/([^/]+)\//);
      if (!match || !vw.vehicles.some((v) => v.vin === match[1])) {
        return reply(404);
      }
      if (url.pathname.endsWith('/metadata/partial')) {
        return vw.dataRequest ? reply(200, { body: { Identifier: 'req-1' } }) : reply(404);
      }
      if (url.pathname.endsWith('/req-1/list')) {
        if (headers.get('type') !== 'partial') return reply(400);
        if (vw.datasets.length === 0) return reply(404, { body: 'No files available' });
        return reply(200, {
          body: [
            ...vw.datasets.map(({ name, createdOn }) => ({ name, createdOn })),
            { name: 'request_asleep_no_content_found.zip', createdOn: '2026-10-17T09:00:00Z' },
          ],
        });
      }
      if (url.pathname.endsWith('/req-1/download')) {
        const dataset = vw.datasets.find((d) => d.name === headers.get('filename'));
        return dataset ? reply(200, { body: zipJson(dataset.content) }) : reply(404);
      }
    }
    return reply(404);
  }

  vw.fetch = async (input, init = {}) => {
    if (init.redirect !== 'manual') {
      throw new Error('the sign-in must follow redirects by hand');
    }
    return handle(new URL(input), init);
  };
  return vw;
}

function requireCookie(cookies, expected) {
  if (!cookies.includes(expected)) {
    throw new Error(`missing cookie ${expected}`);
  }
}
