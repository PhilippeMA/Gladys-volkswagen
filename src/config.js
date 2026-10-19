// -----------------------------------------------------------------------------
// Integration configuration.
//
// The configuration is filled in by the user in Gladys, from the `config_schema`
// declared in `gladys-assistant-integration.json`. The SDK fetches it for you
// (`gladys.getConfig()`) and notifies you of every change through
// `gladys.onConfigUpdated()`.
//
// This module only provides defaults and normalizes the received object, so the
// rest of the code never has to deal with `undefined`.
// -----------------------------------------------------------------------------

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest.
export const DEFAULT_CONFIG = {
  email: '',
  password: '',
  // Seconds between two checks of each car's datasets. The portal stores one
  // every 15 minutes: checking more often than every 3 minutes only loads it. Gladys polls at
  // most once a minute: slower intervals are applied by skipping polls (see
  // createPollScheduler in src/devices/index.js).
  poll_frequency: 300,
  // Optional https address of a picture of the car, for the picture widget:
  // Volkswagen serves none to third parties.
  vehicle_image_url: '',
};

export const MIN_POLL_FREQUENCY = 180;
export const MAX_POLL_FREQUENCY = 3600;

/**
 * Merge the user config with the defaults.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const pollFrequency = Number(raw.poll_frequency ?? DEFAULT_CONFIG.poll_frequency);
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    // Force the types: config may arrive as strings from a form.
    email: String(raw.email ?? '').trim(),
    password: String(raw.password ?? ''),
    vehicle_image_url: String(raw.vehicle_image_url ?? '').trim(),
    poll_frequency: Number.isFinite(pollFrequency)
      ? Math.min(MAX_POLL_FREQUENCY, Math.max(MIN_POLL_FREQUENCY, pollFrequency))
      : DEFAULT_CONFIG.poll_frequency,
  };
}

/** True once the account credentials are filled in. */
export function hasCredentials(config) {
  return Boolean(config.email && config.password);
}
