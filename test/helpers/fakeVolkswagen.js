// -----------------------------------------------------------------------------
// An in-memory Volkswagen: identity provider + CARIAD backend, served through
// a `fetch` replacement. Tests never touch the network.
//
// `loginFlow` picks the login page the identity provider serves: 'legacy'
// (email, then password) or 'single' (the newer one-form page).
// -----------------------------------------------------------------------------

export const VIN = 'WVWZZZE1ZMP012345';

export function sampleVehicle(overrides = {}) {
  return {
    vin: VIN,
    nickname: 'Ma ID.3',
    model: 'ID.3',
    role: 'PRIMARY_USER',
    capabilities: [
      { id: 'access', status: [] },
      { id: 'charging', status: [] },
      { id: 'climatisation', status: [] },
      { id: 'measurements', status: [] },
      { id: 'readiness', status: [] },
      { id: 'vehicleHealthInspection', status: [] },
      { id: 'honkAndFlash', status: [1007] },
    ],
    ...overrides,
  };
}

export function sampleStatus({
  soc = 64,
  chargingState = 'readyForCharging',
  plug = 'connected',
  climatisationState = 'off',
  targetSoc = 80,
} = {}) {
  const at = '2026-10-17T08:00:00Z';
  return {
    charging: {
      batteryStatus: {
        value: { carCapturedTimestamp: at, currentSOC_pct: soc, cruisingRangeElectric_km: 251 },
      },
      chargingStatus: {
        value: {
          carCapturedTimestamp: at,
          chargingState,
          chargePower_kW: chargingState === 'charging' ? 11 : 0,
          chargeRate_kmph: chargingState === 'charging' ? 60 : 0,
          remainingChargingTimeToComplete_min: chargingState === 'charging' ? 95 : 0,
          chargeMode: 'manual',
        },
      },
      chargingSettings: {
        value: {
          carCapturedTimestamp: at,
          maxChargeCurrentAC: 'maximum',
          autoUnlockPlugWhenCharged: 'permanent',
          targetSOC_pct: targetSoc,
        },
      },
      plugStatus: {
        value: {
          carCapturedTimestamp: at,
          plugConnectionState: plug,
          plugLockState: plug === 'connected' ? 'locked' : 'unlocked',
          externalPower: plug === 'connected' ? 'available' : 'unavailable',
        },
      },
    },
    climatisation: {
      climatisationStatus: {
        value: {
          carCapturedTimestamp: at,
          remainingClimatisationTime_min: 0,
          climatisationState,
        },
      },
      climatisationSettings: {
        value: { carCapturedTimestamp: at, targetTemperature_C: 21.5, unitInCar: 'celsius' },
      },
    },
    measurements: {
      odometerStatus: { value: { carCapturedTimestamp: at, odometer: 23456 } },
      temperatureOutsideStatus: {
        value: { carCapturedTimestamp: at, temperatureOutside_K: 285.15 },
      },
      temperatureBatteryStatus: {
        value: {
          carCapturedTimestamp: at,
          temperatureHvBatteryMin_K: 291.15,
          temperatureHvBatteryMax_K: 293.15,
        },
      },
    },
    access: {
      accessStatus: {
        value: {
          carCapturedTimestamp: at,
          overallStatus: 'safe',
          doorLockStatus: 'locked',
          doors: [
            { name: 'frontLeft', status: ['locked', 'closed'] },
            { name: 'bonnet', status: ['closed'] },
          ],
          windows: [{ name: 'frontLeft', status: ['closed'] }],
        },
      },
    },
    readiness: { readinessStatus: { connectionState: { isOnline: true, isActive: false } } },
    vehicleHealthInspection: {
      maintenanceStatus: {
        value: { carCapturedTimestamp: at, inspectionDue_days: 120, inspectionDue_km: 15000 },
      },
    },
  };
}

function jwt(expSeconds) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ exp: expSeconds })}.sig`;
}

function reply(status, { body = '', headers = {}, cookies = [] } = {}) {
  const responseHeaders = new Headers(headers);
  for (const cookie of cookies) {
    responseHeaders.append('set-cookie', cookie);
  }
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  if (typeof body !== 'string') {
    responseHeaders.set('content-type', 'application/json');
  }
  return new Response(status === 204 ? null : text, { status, headers: responseHeaders });
}

export function createFakeVolkswagen({
  email = 'driver@example.com',
  password = 'secret-password',
  loginFlow = 'legacy',
  termsToAccept = false,
  vehicles = [sampleVehicle()],
  status = sampleStatus(),
  now = () => Date.now(),
} = {}) {
  const vw = {
    email,
    password,
    loginFlow,
    termsToAccept,
    vehicles,
    status,
    requests: [],
    logins: 0,
    refreshes: 0,
    tokenGeneration: 0,
    validTokens: new Set(),
    validRefreshTokens: new Set(),
    commandStatus: 200,
    statusCode: 200,

    revokeAccessTokens() {
      this.validTokens.clear();
    },
    revokeRefreshTokens() {
      this.validRefreshTokens.clear();
    },
    commands() {
      return this.requests
        .filter((r) => r.host === 'emea.bff.cariad.digital' && r.method !== 'GET')
        .filter((r) => r.path.startsWith('/vehicle/'));
    },
  };

  function issueTokens() {
    vw.tokenGeneration += 1;
    const accessToken = `${jwt(Math.floor(now() / 1000) + 3600)}.${vw.tokenGeneration}`;
    const refreshToken = `refresh-${vw.tokenGeneration}`;
    vw.validTokens.add(accessToken);
    vw.validRefreshTokens.add(refreshToken);
    return { accessToken, refreshToken };
  }

  const IDENTITY = 'https://identity.vwgroup.io';
  const CLIENT = 'a24fba63-34b3-4d43-b181-942111e6bda8@apps_vw-dilab_com';
  let pendingState;
  let pendingNonce;

  function appRedirect() {
    const params = new URLSearchParams({
      state: pendingState,
      code: 'auth-code',
      access_token: 'idp-access',
      id_token: `idp-id-${pendingNonce}`,
      expires_in: '3600',
      token_type: 'bearer',
    });
    return `weconnect://authenticated#${params}`;
  }

  async function handle(url, init) {
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : undefined;
    const form = headers.get('content-type')?.includes('form') ? new URLSearchParams(body) : null;
    const record = { method, host: url.host, path: url.pathname + url.search, headers, body };
    vw.requests.push(record);

    // --- Identity provider -------------------------------------------------
    if (
      url.origin === 'https://emea.bff.cariad.digital' &&
      url.pathname === '/user-login/v1/authorize'
    ) {
      pendingNonce = url.searchParams.get('nonce');
      pendingState = `state-${vw.logins + 1}`;
      return reply(303, {
        headers: {
          location: `${IDENTITY}/oidc/v1/authorize?client_id=${encodeURIComponent(CLIENT)}&state=${pendingState}`,
        },
      });
    }
    if (url.origin === IDENTITY && url.pathname === '/oidc/v1/authorize') {
      if (vw.loginFlow === 'single') {
        return reply(302, {
          headers: { location: `/u/login?state=${pendingState}` },
          cookies: ['did=device; Domain=.vwgroup.io; Path=/; HttpOnly'],
        });
      }
      return reply(302, {
        headers: { location: `/signin-service/v1/signin/${CLIENT}?relayState=relay-1` },
        cookies: ['SESSION=identity-session; Path=/; HttpOnly'],
      });
    }
    if (url.origin === IDENTITY && url.pathname === `/signin-service/v1/signin/${CLIENT}`) {
      assertCookie(headers, 'SESSION=identity-session');
      return reply(200, {
        body: `<html><body>
<form id="emailPasswordForm" method="POST" action="/signin-service/v1/${CLIENT}/login/identifier">
  <input type="hidden" name="_csrf" value="csrf-1"/>
  <input type="hidden" name="relayState" value="relay-1"/>
  <input type="hidden" name="hmac" value="hmac-1"/>
  <input type="email" name="email" value=""/>
</form></body></html>`,
      });
    }
    if (
      url.origin === IDENTITY &&
      url.pathname === `/signin-service/v1/${CLIENT}/login/identifier`
    ) {
      assertCookie(headers, 'SESSION=identity-session');
      if (form.get('_csrf') !== 'csrf-1' || form.get('hmac') !== 'hmac-1') {
        return reply(403);
      }
      const known = form.get('email') === vw.email;
      return reply(303, {
        headers: {
          location: `/signin-service/v1/${CLIENT}/login/authenticate?relayState=relay-1&known=${known}`,
        },
      });
    }
    if (
      url.origin === IDENTITY &&
      url.pathname === `/signin-service/v1/${CLIENT}/login/authenticate` &&
      method === 'GET'
    ) {
      const model = {
        hmac: 'hmac-2',
        relayState: 'relay-1',
        postAction: 'login/authenticate',
        identifierUrl: 'login/identifier',
        ...(url.searchParams.get('known') === 'false'
          ? { registerCredentialsPath: 'register' }
          : {}),
      };
      return reply(200, {
        body: `<html><script>
window._IDK = {
  templateModel: ${JSON.stringify(model)},
  csrf_token: 'csrf-2',
  disabledFeatures: {}
};
</script></html>`,
      });
    }
    if (
      url.origin === IDENTITY &&
      url.pathname === `/signin-service/v1/${CLIENT}/login/authenticate` &&
      method === 'POST'
    ) {
      if (form.get('_csrf') !== 'csrf-2' || form.get('hmac') !== 'hmac-2') {
        return reply(403);
      }
      if (form.get('password') !== vw.password) {
        return reply(303, {
          headers: {
            location: `/signin-service/v1/${CLIENT}/login/authenticate?relayState=relay-1&error=login.errors.password_invalid`,
          },
        });
      }
      return reply(302, {
        headers: { location: `${IDENTITY}/oidc/v1/oauth/sso?clientId=${CLIENT}&userId=user-1` },
      });
    }
    if (url.origin === IDENTITY && url.pathname === '/u/login') {
      assertCookie(headers, 'did=device');
      if (method === 'GET') {
        return reply(200, {
          body: `<html><form method="POST"><input type="hidden" name="state" value="${pendingState}"><input name="username"><input name="password" type="password"></form></html>`,
        });
      }
      if (form.get('username') !== vw.email || form.get('password') !== vw.password) {
        return reply(400, { body: '<html>Wrong email or password</html>' });
      }
      return reply(302, { headers: { location: `/authorize/resume?state=${pendingState}` } });
    }
    if (url.origin === IDENTITY && url.pathname === '/authorize/resume') {
      return reply(302, { headers: { location: `${IDENTITY}/oidc/v1/oauth/sso?userId=user-1` } });
    }
    if (url.origin === IDENTITY && url.pathname === '/oidc/v1/oauth/sso') {
      if (vw.termsToAccept) {
        return reply(302, {
          headers: { location: `${IDENTITY}/signin-service/v1/terms-and-conditions?x=1` },
        });
      }
      return reply(302, { headers: { location: appRedirect() } });
    }

    // --- CARIAD backend ----------------------------------------------------
    if (url.pathname === '/user-login/login/v1') {
      const payload = JSON.parse(body);
      if (payload.authorizationCode !== 'auth-code' || payload.state !== pendingState) {
        return reply(400);
      }
      vw.logins += 1;
      const { accessToken, refreshToken } = issueTokens();
      return reply(200, { body: { accessToken, refreshToken, idToken: 'id-token' } });
    }
    if (url.pathname === '/login/v1/idk/token') {
      if (
        form.get('grant_type') !== 'refresh_token' ||
        !vw.validRefreshTokens.has(form.get('refresh_token'))
      ) {
        return reply(401);
      }
      vw.refreshes += 1;
      const { accessToken } = issueTokens();
      // A refresh answers snake_case, without a new refresh token.
      return reply(200, {
        body: { access_token: accessToken, expires_in: 3600, id_token: 'id-2' },
      });
    }
    if (url.pathname.startsWith('/vehicle/v1/')) {
      const token = headers.get('authorization')?.replace(/^Bearer /, '');
      if (!vw.validTokens.has(token)) {
        return reply(401);
      }
      if (url.pathname === '/vehicle/v1/vehicles') {
        return reply(200, { body: { data: vw.vehicles } });
      }
      const match = url.pathname.match(/^\/vehicle\/v1\/vehicles\/([^/]+)\/(.+)$/);
      if (!match || !vw.vehicles.some((v) => v.vin === match[1])) {
        return reply(404);
      }
      const [, , action] = match;
      if (action === 'selectivestatus') {
        if (vw.statusCode !== 200) {
          return reply(vw.statusCode);
        }
        const jobs = url.searchParams.get('jobs').split(',');
        return reply(200, {
          body: Object.fromEntries(Object.entries(vw.status).filter(([job]) => jobs.includes(job))),
        });
      }
      if (action === 'parkingposition') {
        return reply(200, { body: { data: { lat: 48.85, lon: 2.35, carCapturedTimestamp: 'x' } } });
      }
      return reply(vw.commandStatus, { body: { data: { requestID: 'req-1' } } });
    }
    return reply(404);
  }

  vw.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (init.redirect !== 'manual' && url.host === 'identity.vwgroup.io') {
      throw new Error('the sign-in must follow redirects by hand');
    }
    return handle(url, init);
  };
  return vw;
}

function assertCookie(headers, expected) {
  if (!(headers.get('cookie') ?? '').includes(expected)) {
    throw new Error(`missing cookie ${expected}`);
  }
}
