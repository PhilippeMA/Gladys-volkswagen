// -----------------------------------------------------------------------------
// Device registry.
//
// The integration has one device type, the vehicle (src/devices/vehicle.js),
// instantiated once per car of the account. This module holds what is common
// to every device: the scene triggers they fire and the poll scheduler.
// -----------------------------------------------------------------------------

import { DEVICE_POLL_FREQUENCIES } from '@gladysassistant/integration-sdk';
import { CHARGING_COMPLETED_TRIGGER } from './vehicle.js';

// Every scene trigger key the devices fire: each one must be declared in the
// manifest `scene_triggers` field, or the core answers 404 (see the tests).
export const SCENE_TRIGGER_KEYS = [CHARGING_COMPLETED_TRIGGER];

// Gladys' poll ticks drift by a few milliseconds: a read due within the next
// half-minute runs now, so a 300 s interval does not slip to 360 s.
const POLL_TOLERANCE_MS = DEVICE_POLL_FREQUENCIES.EVERY_MINUTES / 2;

/**
 * Create the poll scheduler: Gladys polls every vehicle once a minute (the
 * slowest pace it schedules), the Volkswagen portal is only read at the
 * interval the user chose (`poll_frequency` config, in seconds) — it stores
 * a new dataset every 15 minutes at best.
 *
 * `isDue(id, intervalSeconds)` tells whether a read is due, `markRead(id)`
 * records one.
 */
export function createPollScheduler(now = () => Date.now()) {
  const lastReads = new Map();
  return {
    isDue(id, intervalSeconds) {
      const lastRead = lastReads.get(id);
      return (
        lastRead === undefined || now() - lastRead >= intervalSeconds * 1000 - POLL_TOLERANCE_MS
      );
    },
    markRead(id) {
      lastReads.set(id, now());
    },
    clear() {
      lastReads.clear();
    },
  };
}
