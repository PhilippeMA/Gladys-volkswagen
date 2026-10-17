// -----------------------------------------------------------------------------
// Manifest actions: the buttons of the Configuration screen.
//
// Each key matches an entry of the manifest `actions` field; index.js
// registers them with `gladys.onAction(key, ...)`. The resolved
// multi-language message is displayed under the button; a thrown error is
// shown as a failure.
// -----------------------------------------------------------------------------

import { vehicleName } from './devices/vehicle.js';
import { VwAuthError } from './vw/auth.js';

export function createActions(service) {
  return {
    // Sign in and list the cars: the first thing to try after entering the
    // credentials.
    async test_connection() {
      if (!service.configured) {
        return {
          en: 'Enter the email address and the password of your Volkswagen account first.',
          fr: 'Renseignez d’abord l’adresse e-mail et le mot de passe de votre compte Volkswagen.',
        };
      }
      try {
        const vehicles = await service.loadVehicles();
        if (vehicles.length === 0) {
          return {
            en: 'Signed in, but the account has no vehicle.',
            fr: 'Connexion réussie, mais le compte n’a aucun véhicule.',
          };
        }
        const names = vehicles.map(vehicleName).join(', ');
        return {
          en: `Signed in. Vehicles found: ${names}. Add them from the Discovery tab.`,
          fr: `Connexion réussie. Véhicules trouvés : ${names}. Ajoutez-les depuis l’onglet Découverte.`,
        };
      } catch (err) {
        if (err instanceof VwAuthError) {
          return err.userMessage;
        }
        return {
          en: `Volkswagen did not answer: ${err.message}`,
          fr: `Volkswagen n’a pas répondu : ${err.message}`,
        };
      }
    },

    // The car only reports new values when it is awake (driving, charging,
    // or woken up): ask it to.
    async wake_up(fields) {
      const vehicle = await service.wakeUp(fields.device);
      const name = vehicleName(vehicle);
      return {
        en: `${name} is waking up: fresh values arrive within a few minutes.`,
        fr: `${name} se réveille : les nouvelles valeurs arrivent d’ici quelques minutes.`,
      };
    },
  };
}
