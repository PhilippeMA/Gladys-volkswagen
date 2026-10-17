// -----------------------------------------------------------------------------
// Entry point of the Volkswagen ID. integration for Gladys Assistant.
//
// Role of this file: wire the SDK to the vehicle service (src/vehicles.js).
// It holds NO Volkswagen logic. It only:
//   1. instantiates the SDK (connection, auth, reconnection: handled for you);
//   2. registers the event handlers BEFORE connect();
//   3. connects, signs in to the Volkswagen account and publishes the cars.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './src/config.js';
import { createActions } from './src/actions.js';
import { VehicleService } from './src/vehicles.js';
import { VwClient } from './src/vw/client.js';
import { createFileTokenStore } from './src/vw/tokenStore.js';
import { WIDGETS, refreshWidgets } from './src/widgets.js';

const gladys = new GladysIntegration();

// One token file under /data, the only writable volume: a restart refreshes
// the session instead of signing in again.
const tokenStore = createFileTokenStore({ logger });
const service = new VehicleService(gladys, {
  createClient: (config) =>
    new VwClient({ email: config.email, password: config.password, tokenStore }),
});
// Every status read can change the widget's computed rows.
service.onStatus = () => refreshWidgets(gladys);

// (Re)load the cars of the account and publish them in the Discovery tab.
// A failed listing keeps the previous Discovery list: the status read by
// the next poll or scan will try again.
async function publishVehicles() {
  try {
    await service.loadVehicles();
  } catch (err) {
    logger.error(`Could not list the Volkswagen vehicles: ${err.message}`);
    return;
  }
  await gladys.publishDiscoveredDevices(service.discoveredDevices());
  refreshWidgets(gladys);
}

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> listing the vehicles of the account');
  await publishVehicles();
});

// --- Command: the user acts on a controllable feature ------------------------
// Throwing sends a success:false acknowledgement: Gladys shows the failure.
gladys.onSetValue(async (device, feature, value) => {
  logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
  await service.setValue(device, feature, value);
});

// --- Polling: Gladys asks to refresh a vehicle -------------------------------
// Gladys polls every vehicle once a minute; the service only reads the car at
// the interval the user chose in the configuration.
gladys.onPoll(async (device) => {
  if (!(await service.poll(device))) {
    logger.debug(`onPoll skipped (not due) for ${device.external_id}`);
  }
});

// --- Manifest actions: buttons in the Configuration screen -------------------
for (const [actionKey, handler] of Object.entries(createActions(service))) {
  gladys.onAction(actionKey, (fields) => handler(fields));
}

// --- Dashboard widgets -------------------------------------------------------
for (const [widgetKey, widget] of Object.entries(WIDGETS)) {
  gladys.onWidgetGet(widgetKey, (request) => widget.get(gladys, { ...request, service }));
  gladys.onWidgetAction(widgetKey, (actionKey, params, { settings }) =>
    widget.action(gladys, { actionKey, params, settings, service }),
  );
}

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  // New credentials start a new Volkswagen session; a new refresh interval
  // or S-PIN applies from the next poll. Saving again after a failure
  // retries the listing (the client still spaces out refused sign-ins).
  const credentialsChanged = service.configure(normalizeConfig(newConfig));
  if (credentialsChanged || !service.vehiclesLoaded) {
    service.forgetConnectionStatus();
    await publishVehicles();
  }
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK itself logs the WebSocket lifecycle under the `gladys-sdk` name.
gladys.on('connected', async () => {
  try {
    service.configure(normalizeConfig(await gladys.getConfig()));
    // Report the account status again: Gladys may have restarted meanwhile.
    service.forgetConnectionStatus();
    // The Volkswagen session survives reconnections (and restarts, through
    // the token file): listing the cars costs one request, not a sign-in.
    await publishVehicles();
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Volkswagen integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
