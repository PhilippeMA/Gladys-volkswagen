# Volkswagen ID. — Gladys Assistant integration

External integration for [Gladys Assistant](https://gladysassistant.com) that
brings the Volkswagen **ID.** electric cars (ID.3, ID.4, ID.5, ID.7, ID. Buzz…)
into Gladys, through the Volkswagen cloud and the account of the Volkswagen
smartphone app.

Built from the official
[JavaScript integration template](https://github.com/GladysAssistant/integration-template-js)
with the SDK
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

- **Devices** — one per car: battery level, range, battery temperature,
  charging (start/stop), charging power, cable plugged, charge limit,
  remaining charging time, climatisation (start/stop) and its temperature,
  outside temperature, odometer, doors/windows open, locks (with the S-PIN).
- **Scene trigger** — `charging_completed`, when a charge reaches its limit.
- **Dashboard widget** — `vehicle_status`, one car at a glance with quick
  controls.
- **Actions** — test the connection, wake a car up.

User documentation: [English](docs/en.md) · [Français](docs/fr.md).

> Volkswagen publishes no API for third parties. This integration speaks to
> the same backend as the official app, as documented by the open-source
> [WeConnect-python](https://github.com/tillsteinbach/WeConnect-python) /
> [CarConnectivity](https://github.com/tillsteinbach/CarConnectivity-connector-volkswagen)
> projects. All the endpoints, client ids and headers live in
> [`src/vw/auth.js`](src/vw/auth.js) and [`src/vw/client.js`](src/vw/client.js),
> so a change on Volkswagen's side is fixed in one place.

## Project structure

```
.
├─ index.js                          # SDK wiring only (handlers, connection lifecycle)
├─ src/
│  ├─ vw/
│  │  ├─ http.js                     # cookie jar + manual-redirect web session
│  │  ├─ auth.js                     # Volkswagen ID sign-in, token refresh
│  │  ├─ tokenStore.js               # tokens persisted under /data
│  │  ├─ client.js                   # CARIAD API: vehicles, status, commands
│  │  └─ status.js                   # raw `selectivestatus` -> flat state
│  ├─ devices/
│  │  ├─ vehicle.js                  # the vehicle device: features, states
│  │  └─ index.js                    # scene trigger keys, poll scheduler
│  ├─ vehicles.js                    # service: polls, commands, scene events
│  ├─ actions.js                     # manifest actions (Configuration screen)
│  ├─ widgets.js                     # dashboard widget
│  └─ config.js                      # config defaults + normalization
├─ docs/en.md, docs/fr.md            # user documentation (re-hosted by Gladys)
├─ test/                             # node --test, fake Gladys + fake Volkswagen
└─ gladys-assistant-integration.json # manifest
```

## How it works

1. **Sign-in** ([`src/vw/auth.js`](src/vw/auth.js)): the CARIAD backend hands
   out an OpenID authorization URL; the identity provider
   (`identity.vwgroup.io`) serves the login page — the legacy two-step
   email/password form or the newer single form, both supported — and ends
   on `weconnect://authenticated#…`; the OpenID tokens of that fragment are
   swapped for the backend's own access/refresh tokens. Every redirect is
   followed by hand with a cookie jar, without any dependency.
2. **Session** ([`src/vw/client.js`](src/vw/client.js)): the access token is
   refreshed before it expires, a 401 renews it once, a refused refresh token
   falls back to a full sign-in. A refused sign-in is not retried for 15
   minutes (Volkswagen locks accounts that fail too often). The tokens are
   saved in `/data/vw-tokens.json` (mode 600, keyed by a hash of the email),
   so a restart costs a refresh, not a sign-in.
3. **Status**: Gladys polls each car once a minute; the service reads
   `selectivestatus` at the configured interval only (5 min by default,
   3 min minimum), asking only for the jobs the car has the capability for,
   and publishes the changed values with `publishChangedStates`.
4. **Commands**: a Gladys command calls the matching endpoint (`charging/start`,
   `climatisation/settings`, `access/lock`…), publishes the requested value,
   and brings the next read forward to confirm it.

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="volkswagen" \
DATA_DIR="./data" \
LOG_LEVEL=debug \
npm start
```

The three `GLADYS_*` variables are injected by the Gladys supervisor in the
container. `DATA_DIR` (default `/data`) is where the session tokens are kept.

## Quality checks

```bash
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # node --test: fake Gladys (SDK) + fake Volkswagen, no network
npx github:GladysAssistant/integration-store .   # store admission checks
```

The tests run the real sign-in code against an in-memory Volkswagen
([`test/helpers/fakeVolkswagen.js`](test/helpers/fakeVolkswagen.js)) that
serves both login pages, the token exchange, the refresh, the vehicle list,
the status and the commands, and checks the cookies and the CSRF values on
the way. The CI runs the three checks on Node 22 and 24 and builds the image.

## Publish

1. Replace `cover.png` with a real 800×534 px cover (≤ 150 KB): the bundled
   one is the template's placeholder. Check that the manifest `cover_image`
   URL points at the default branch of this repository.
2. Add the GitHub topic `gladys-assistant-integration` to the repository and
   make it public.
3. Describe the changes under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md),
   then run **Actions → Release → Run workflow** (`patch`, `minor` or
   `major`): it bumps the versions, tags, builds the multi-arch image to
   `ghcr.io/philippema/gladys-volkswagen` and publishes the GitHub Release.
4. Make the published package public in the GitHub Packages settings, so
   Gladys can pull the image.

## License

Apache-2.0. Not affiliated with, nor endorsed by, Volkswagen AG or CARIAD.
