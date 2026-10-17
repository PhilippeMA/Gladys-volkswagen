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
 * slowest pace it schedules), the Volkswagen API is only read at the
 * interval the user chose (`poll_frequency` config, in seconds) — it
 * rate-limits accounts that read too often.
 *
 * `isDue(id, intervalSeconds)` tells whether a read is due, `markRead(id)`
 * records one, `readSoon(id, delayMs)` brings the next read forward — after
 * a command, to confirm the new state once the car had time to act (reading
 * right away would fetch the old state back).
 */
export function createPollScheduler(now = () => Date.now()) {
  const lastReads = new Map();
  const earlyReads = new Map();
  return {
    isDue(id, intervalSeconds) {
      const early = earlyReads.get(id);
      if (early !== undefined && now() >= early) {
        return true;
      }
      const lastRead = lastReads.get(id);
      return (
        lastRead === undefined || now() - lastRead >= intervalSeconds * 1000 - POLL_TOLERANCE_MS
      );
    },
    markRead(id) {
      lastReads.set(id, now());
      earlyReads.delete(id);
    },
    readSoon(id, delayMs) {
      earlyReads.set(id, now() + delayMs);
    },
    clear() {
      lastReads.clear();
      earlyReads.clear();
    },
  };
}
