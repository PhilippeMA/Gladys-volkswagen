// -----------------------------------------------------------------------------
// Dashboard widgets (SDK v0.14+, Gladys 5.1+).
//
// `vehicle_status`: one car at a glance. The battery and range tiles are
// bound to the device features (live, they follow the published states); the
// status list is computed from the last datasets read. The only widget
// action is "Refresh": check the portal for new datasets now. There is no
// control: the EU Data Act portal is read-only.
//
// Each entry of WIDGETS is keyed by the widget `key` and exposes:
//   - get(gladys, { settings, language, units, service }): the content;
//   - action(gladys, { actionKey, params, settings, service }): a tapped
//     `button` carrying an `action`.
// -----------------------------------------------------------------------------

import { createLogger, WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { vehicleIds, vehicleName } from './devices/vehicle.js';

const logger = createLogger({ name: 'widgets' });

// Widget key, as declared in the manifest `widgets` field.
export const VEHICLE_STATUS_WIDGET = 'vehicle_status';

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

export const WIDGETS = {
  [VEHICLE_STATUS_WIDGET]: {
    async get(gladys, { settings, service }) {
      logger.debug(`onWidgetGet <- ${VEHICLE_STATUS_WIDGET}`);
      const vehicle = pickVehicle(service, settings);
      if (!vehicle) {
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
      const status = service.statusOf(vehicle.vin) ?? {};
      const battery = featureOf(gladys, service, vehicle, 'battery-level');
      const range = featureOf(gladys, service, vehicle, 'range');
      const items = statusItems(status);
      return {
        // The computed rows follow the status reads, and index.js nudges the
        // widget after each one: the TTL is only a safety net.
        ttl_seconds: 600,
        components: [
          { type: 'text', variant: 'heading', text: vehicleName(vehicle).slice(0, 40) },
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
          ...(items.length > 0
            ? [{ type: 'status', items }]
            : [
                {
                  type: 'text',
                  variant: 'caption',
                  text: text(
                    'Waiting for the first dataset from Volkswagen.',
                    'En attente des premières données Volkswagen.',
                  ),
                },
              ]),
          {
            type: 'button',
            label: text('Refresh', 'Actualiser'),
            icon: 'refresh-cw',
            style: 'secondary',
            action: { key: ACTIONS.REFRESH, params: { vin: vehicle.vin } },
          },
        ],
      };
    },

    async action(gladys, { actionKey, params, service }) {
      logger.info(`onWidgetAction <- ${VEHICLE_STATUS_WIDGET}.${actionKey}`);
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
    },
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
