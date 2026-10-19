// -----------------------------------------------------------------------------
// Dashboard widgets (SDK v0.14+, Gladys 5.1+).
//
// `vehicle_status`: one car at a glance. The battery and range tiles are
// bound to the device features (live, they follow the published states); the
// status list is computed from the last datasets read. The only widget
// action is "Refresh": check the portal for new datasets now. There is no
// control: the EU Data Act portal is read-only.
//
// `vehicle_picture`: the same car around the picture the portal holds for
// it — its own model and colour, never a generic image — served through
// onWidgetGetImage (see VehicleService.vehiclePicture).
//
// Both show the name the user gave the device in Gladys.
//
// Each entry of WIDGETS is keyed by the widget `key` and exposes:
//   - get(gladys, { settings, language, units, service }): the content;
//   - action(gladys, { actionKey, params, settings, service }): a tapped
//     `button` carrying an `action`.
// -----------------------------------------------------------------------------

import { createLogger, WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { vehicleIds } from './devices/vehicle.js';

const logger = createLogger({ name: 'widgets' });

// Widget keys, as declared in the manifest `widgets` field.
export const VEHICLE_STATUS_WIDGET = 'vehicle_status';
export const VEHICLE_PICTURE_WIDGET = 'vehicle_picture';

const ACTIONS = { REFRESH: 'refresh' };

const CHARGING_STATES = {
  charging: { en: 'Charging', fr: 'En charge', color: WIDGET_COLORS.SUCCESS },
  readyForCharging: { en: 'Ready to charge', fr: 'Prêt à charger', color: WIDGET_COLORS.INFO },
  notReadyForCharging: { en: 'Not charging', fr: 'Pas en charge', color: WIDGET_COLORS.NEUTRAL },
  chargePurposeReachedAndConservation: {
    en: 'Charge complete',
    fr: 'Charge terminée',
    color: WIDGET_COLORS.SUCCESS,
  },
  chargePurposeReachedAndNotConservationCharging: {
    en: 'Charge complete',
    fr: 'Charge terminée',
    color: WIDGET_COLORS.SUCCESS,
  },
  conservation: { en: 'Maintenance charge', fr: 'Charge d’entretien', color: WIDGET_COLORS.INFO },
  discharging: { en: 'Discharging', fr: 'Décharge', color: WIDGET_COLORS.WARNING },
  error: { en: 'Charging error', fr: 'Erreur de charge', color: WIDGET_COLORS.DANGER },
  off: { en: 'Off', fr: 'Arrêtée', color: WIDGET_COLORS.NEUTRAL },
};

const text = (en, fr) => ({ en, fr });

function chargingItem(status) {
  const known = CHARGING_STATES[status.chargingState];
  let value = known ? text(known.en, known.fr) : text('Unknown', 'Inconnu');
  if (status.charging && status.remainingChargingTime !== undefined) {
    const minutes = status.remainingChargingTime;
    const duration = `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
    value = text(`Charging, ${duration} left`, `En charge, reste ${duration}`);
  }
  return {
    label: text('Charge', 'Charge'),
    icon: 'battery-charging',
    value,
    color: known?.color ?? WIDGET_COLORS.NEUTRAL,
  };
}

function statusItems(status) {
  const items = [];
  if (status.chargingState !== undefined) {
    items.push(chargingItem(status));
  }
  if (status.plugged !== undefined) {
    items.push({
      label: text('Cable', 'Câble'),
      icon: 'power',
      value: status.plugged ? text('Plugged in', 'Branché') : text('Unplugged', 'Débranché'),
      color: status.plugged ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.NEUTRAL,
    });
  }
  if (status.locked !== undefined) {
    items.push({
      label: text('Doors', 'Portes'),
      icon: status.locked ? 'lock' : 'unlock',
      value: status.locked ? text('Locked', 'Verrouillées') : text('Unlocked', 'Déverrouillées'),
      color: status.locked ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.WARNING,
    });
  }
  if (status.doorsOpen || status.windowsOpen) {
    items.push({
      label: text('Openings', 'Ouvrants'),
      icon: 'alert-triangle',
      value: status.doorsOpen
        ? text('A door is open', 'Une porte est ouverte')
        : text('A window is open', 'Une vitre est ouverte'),
      color: WIDGET_COLORS.WARNING,
    });
  }
  return items;
}

/** Feature external id if the vehicle device publishes that feature. */
function featureOf(gladys, service, vehicle, key) {
  const device = service
    .discoveredDevices()
    .find((candidate) => candidate.external_id === vehicleIds(gladys, vehicle.vin).device);
  return device?.features.find((feature) => feature.external_id.endsWith(`:${key}`))?.external_id;
}

/** The car a widget instance shows: the chosen one, else the first. */
function pickVehicle(service, settings) {
  if (settings?.vehicle) {
    return service.findVehicle(settings.vehicle);
  }
  return service.vehicles[0];
}

function noVehicleContent(service) {
  return {
    ttl_seconds: 300,
    components: [
      {
        type: 'text',
        variant: 'body',
        text: service.configured
          ? text(
              'No vehicle found on the Volkswagen account.',
              'Aucun véhicule trouvé sur le compte Volkswagen.',
            )
          : text(
              'Configure the Volkswagen integration first.',
              'Configurez d’abord l’intégration Volkswagen.',
            ),
      },
    ],
  };
}

/** Battery gauge and range tile, bound to the device features (live). */
function liveTiles(gladys, service, vehicle) {
  const battery = featureOf(gladys, service, vehicle, 'battery-level');
  const range = featureOf(gladys, service, vehicle, 'range');
  return [
    ...(battery
      ? [{ type: 'gauge', label: text('Battery', 'Batterie'), device_feature: battery }]
      : []),
    ...(range
      ? [
          {
            type: 'value',
            label: text('Range', 'Autonomie'),
            icon: 'navigation',
            device_feature: range,
          },
        ]
      : []),
  ];
}

/** The computed status list, or a caption while no dataset arrived. */
function statusOrWaiting(service, vehicle) {
  const items = statusItems(service.statusOf(vehicle.vin) ?? {});
  if (items.length > 0) {
    return { type: 'status', items };
  }
  return {
    type: 'text',
    variant: 'caption',
    text: text(
      'Waiting for the first dataset from Volkswagen.',
      'En attente des premières données Volkswagen.',
    ),
  };
}

function refreshButton(vehicle) {
  return {
    type: 'button',
    label: text('Refresh', 'Actualiser'),
    icon: 'refresh-cw',
    style: 'secondary',
    action: { key: ACTIONS.REFRESH, params: { vin: vehicle.vin } },
  };
}

function heading(service, vehicle) {
  return { type: 'text', variant: 'heading', text: service.displayName(vehicle).slice(0, 40) };
}

// Resolve an optional toast (≤ 200 characters). After a successful action the
// core drops the cached content and every open dashboard refetches it.
async function refreshAction(widgetKey, { actionKey, params, service }) {
  logger.info(`onWidgetAction <- ${widgetKey}.${actionKey}`);
  if (actionKey === ACTIONS.REFRESH) {
    const vehicle = service.vehicles.find((candidate) => candidate.vin === params.vin);
    if (!vehicle) {
      throw new Error('Unknown vehicle');
    }
    await service.refreshStatus(vehicle);
    return text('Vehicle data refreshed.', 'Données du véhicule actualisées.');
  }
  // Throwing acks the action as failed: the message reaches the user.
  throw new Error(`Unknown widget action: ${actionKey}`);
}

export const WIDGETS = {
  [VEHICLE_STATUS_WIDGET]: {
    async get(gladys, { settings, service }) {
      logger.debug(`onWidgetGet <- ${VEHICLE_STATUS_WIDGET}`);
      const vehicle = pickVehicle(service, settings);
      if (!vehicle) {
        return noVehicleContent(service);
      }
      return {
        // The computed rows follow the status reads, and index.js nudges the
        // widget after each one: the TTL is only a safety net.
        ttl_seconds: 600,
        components: [
          heading(service, vehicle),
          ...liveTiles(gladys, service, vehicle),
          statusOrWaiting(service, vehicle),
          refreshButton(vehicle),
        ],
      };
    },

    action: (gladys, request) => refreshAction(VEHICLE_STATUS_WIDGET, request),
  },

  [VEHICLE_PICTURE_WIDGET]: {
    async get(gladys, { settings, service }) {
      logger.debug(`onWidgetGet <- ${VEHICLE_PICTURE_WIDGET}`);
      const vehicle = pickVehicle(service, settings);
      if (!vehicle) {
        return noVehicleContent(service);
      }
      const picture = await service.vehiclePicture(vehicle);
      const status = statusOrWaiting(service, vehicle);
      let image;
      if (picture) {
        image = {
          type: 'image',
          key: picture.key,
          alt: service.displayName(vehicle).slice(0, 80),
          fit: 'contain',
        };
      } else if (status.type !== 'text') {
        // Two texts at most per content: the "waiting" caption wins.
        image = {
          type: 'text',
          variant: 'caption',
          text: text(
            'Volkswagen provides no picture of this car.',
            'Volkswagen ne fournit pas d’image de cette voiture.',
          ),
        };
      }
      return {
        // The picture key only changes with the portal's picture location.
        ttl_seconds: 600,
        components: [
          heading(service, vehicle),
          ...(image ? [image] : []),
          ...liveTiles(gladys, service, vehicle),
          status,
          refreshButton(vehicle),
        ],
      };
    },

    action: (gladys, request) => refreshAction(VEHICLE_PICTURE_WIDGET, request),
  },
};

/**
 * Freshness nudge: ask the core to re-pull every widget NOW instead of
 * waiting for the content TTL — after a status read, a (re)connection or a
 * configuration change. Rate-limited core-side to 1 per 10 s per widget.
 */
export function refreshWidgets(gladys) {
  for (const key of Object.keys(WIDGETS)) {
    gladys.requestWidgetRefresh(key);
  }
}
