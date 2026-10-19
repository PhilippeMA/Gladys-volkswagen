# Volkswagen ID. — Gladys Assistant integration

External integration for [Gladys Assistant](https://gladysassistant.com) that
brings the data of the Volkswagen **ID.** electric cars (ID.3, ID.4, ID.5,
ID.7, ID. Buzz…) into Gladys, through Volkswagen's **EU Data Act portal** and
the account of the Volkswagen smartphone app.

Built from the official
[JavaScript integration template](https://github.com/GladysAssistant/integration-template-js)
with the SDK
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

- **Devices** — one per car, read-only: battery level, range, charging,
  charging power, cable plugged, charge limit, remaining charging time,
  outside temperature, odometer, doors/windows open, locks.
- **Scene trigger** — `charging_completed`, when a charge reaches its limit.
- **Dashboard widgets** — `vehicle_status`, one car at a glance, and
  `vehicle_picture`, the same around the portal's picture of the car.
- **Action** — test the connection.

User documentation: [English](docs/en.md) · [Français](docs/fr.md).

> **Read-only, by necessity.** Volkswagen retired the OAuth client of the ID.
> app API on 2026-06-01: its sign-in now answers HTTP 403 to every
> third-party client. The only data source left open is the
> [EU Data Act portal](https://eu-data-act.drivesomethinggreater.com), which
> stores a dataset of the car every 15 minutes and takes no command. The flow
> follows the open-source
> [ioBroker.vw-connect](https://github.com/TA2k/ioBroker.vw-connect) and
> [evcc](https://github.com/evcc-io/evcc) clients, which made the same move.
> All the endpoints, client ids and headers live in
> [`src/vw/auth.js`](src/vw/auth.js) and [`src/vw/client.js`](src/vw/client.js),
> so a change on Volkswagen's side is fixed in one place.

## Project structure

```
.
├─ index.js                          # SDK wiring only (handlers, connection lifecycle)
├─ src/
│  ├─ vw/
│  │  ├─ transport.js                # node:https fetch-like transport (exact headers)
│  │  ├─ http.js                     # cookie jar + manual-redirect web session
│  │  ├─ auth.js                     # sign-in to the EU Data Act portal
│  │  ├─ client.js                   # portal API: vehicles, data request, datasets
│  │  ├─ zip.js                      # dataset archive reader
│  │  └─ status.js                   # dataset data points -> flat state
│  ├─ devices/
│  │  ├─ vehicle.js                  # the vehicle device: features, states
│  │  └─ index.js                    # scene trigger keys, poll scheduler
│  ├─ vehicles.js                    # service: polls, dataset merge, scene events
│  ├─ actions.js                     # manifest actions (Configuration screen)
│  ├─ widgets.js                     # dashboard widget
│  └─ config.js                      # config defaults + normalization
├─ docs/en.md, docs/fr.md            # user documentation (re-hosted by Gladys)
├─ test/                             # node --test, fake Gladys + fake Volkswagen
└─ gladys-assistant-integration.json # manifest
```

## How it works

1. **One-time portal setup** (by the user, in a browser, see
   [docs](docs/en.md)): link the car and enable a continuous data request,
   every 15 minutes.
2. **Sign-in** ([`src/vw/auth.js`](src/vw/auth.js)): the OpenID authorization
   of the portal's own client on `identity.vwgroup.io` serves the email form,
   then the password page; the redirects lead back to the portal, whose
   callback sets the session cookies (`access_token`). The flow stops before
   the portal's landing page, and skips the optional marketing consent through
   its own callback. Every redirect is followed by hand with a cookie jar,
   without any dependency.
3. **Session** ([`src/vw/client.js`](src/vw/client.js)): the session is the
   cookie jar, kept in memory. A 401/403 (or the portal's HTML error page)
   signs in again once. A refused sign-in is not retried for 15 minutes
   (Volkswagen locks accounts that fail too often).
4. **Data**: Gladys polls each car once a minute; at the configured interval
   (5 min by default, 3 min minimum) the service lists the car's datasets,
   downloads the new ones (the 4 newest on the first read), merges their data
   points — the newest wins, a parked car sends few — and publishes the
   changed values with `publishChangedStates`.

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="volkswagen" \
LOG_LEVEL=debug \
npm start
```

The three `GLADYS_*` variables are injected by the Gladys supervisor in the
container. The integration writes nothing to disk.

## Quality checks

```bash
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # node --test: fake Gladys (SDK) + fake Volkswagen, no network
npx github:GladysAssistant/integration-store .   # store admission checks
```

The tests run the real sign-in code against an in-memory Volkswagen
([`test/helpers/fakeVolkswagen.js`](test/helpers/fakeVolkswagen.js)) that
serves the identity pages, the portal callbacks, the vehicle list, the data
request and the dataset archives, and checks the cookies and the CSRF values
on the way. The CI runs the three checks on Node 22 and 24 and builds the image.

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

Apache-2.0. Not affiliated with, nor endorsed by, Volkswagen AG.
