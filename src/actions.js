// -----------------------------------------------------------------------------
// Manifest actions: the buttons of the Configuration screen.
//
// Each key matches an entry of the manifest `actions` field; index.js
// registers them with `gladys.onAction(key, ...)`. The resolved
// multi-language message is displayed under the button.
// -----------------------------------------------------------------------------

import { vehicleName } from './devices/vehicle.js';
import { MESSAGES, VwAuthError } from './vw/auth.js';
import { NoDataRequestError } from './vw/client.js';

export function createActions(service) {
  return {
    // Sign in, list the cars and read them once: the whole chain the
    // integration needs, checked in one click after entering the credentials.
    async test_connection() {
      if (!service.configured) {
        return MESSAGES.missingCredentials;
      }
      try {
        const vehicles = await service.loadVehicles();
        if (vehicles.length === 0) {
          return {
            en: 'Signed in, but no car is linked to the Volkswagen EU Data Act portal yet (see the documentation).',
            fr: 'Connexion réussie, mais aucune voiture n’est encore liée au portail EU Data Act de Volkswagen (voir la documentation).',
          };
        }
        const names = vehicles.map(vehicleName).join(', ');
        const waiting = [];
        for (const vehicle of vehicles) {
          const status = await service.refreshStatus(vehicle);
          if (!status) {
            waiting.push(vehicleName(vehicle));
          }
        }
        if (waiting.length > 0) {
          return {
            en: `Signed in. Cars found: ${names}. The portal has no data yet for ${waiting.join(', ')}: it arrives once the car has been driven or charged.`,
            fr: `Connexion réussie. Voitures trouvées : ${names}. Le portail n’a pas encore de données pour ${waiting.join(', ')} : elles arrivent quand la voiture a roulé ou chargé.`,
          };
        }
        return {
          en: `Signed in. Cars found: ${names}. Add them from the Discovery tab.`,
          fr: `Connexion réussie. Voitures trouvées : ${names}. Ajoutez-les depuis l’onglet Découverte.`,
        };
      } catch (err) {
        if (err instanceof VwAuthError) {
          return err.userMessage;
        }
        if (err instanceof NoDataRequestError) {
          return {
            en: 'Signed in, but the continuous data request is not enabled on the Volkswagen EU Data Act portal (see the documentation).',
            fr: 'Connexion réussie, mais la demande de données continue n’est pas activée sur le portail EU Data Act de Volkswagen (voir la documentation).',
          };
        }
        return {
          en: `Volkswagen did not answer: ${err.message}`,
          fr: `Volkswagen n’a pas répondu : ${err.message}`,
        };
      }
    },
  };
}
