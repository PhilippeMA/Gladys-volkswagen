// -----------------------------------------------------------------------------
// Token persistence under /data, the only writable volume of the container.
//
// Signing in replays the whole browser flow and Volkswagen throttles accounts
// that sign in too often: keeping the tokens across restarts means a restart
// costs one refresh, not a sign-in. The file is keyed by a hash of the email,
// so changing account in the configuration never reuses the other account's
// tokens.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_DATA_DIR = process.env.DATA_DIR ?? '/data';

export function accountKey(email) {
  return createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex').slice(0, 16);
}

/** A store backed by `<dataDir>/vw-tokens.json`. Every failure is non-fatal. */
export function createFileTokenStore({ dataDir = DEFAULT_DATA_DIR, logger } = {}) {
  const file = path.join(dataDir, 'vw-tokens.json');
  return {
    async load(email) {
      try {
        const saved = JSON.parse(await readFile(file, 'utf8'));
        return saved.account === accountKey(email) ? saved.tokens : undefined;
      } catch (err) {
        if (err.code !== 'ENOENT') {
          logger?.warn(`Saved Volkswagen tokens unreadable, signing in again (${err.message})`);
        }
        return undefined;
      }
    },
    async save(email, tokens) {
      try {
        await mkdir(dataDir, { recursive: true });
        await writeFile(file, JSON.stringify({ account: accountKey(email), tokens }), {
          mode: 0o600,
        });
      } catch (err) {
        logger?.warn(`Could not save the Volkswagen tokens (${err.message})`);
      }
    },
    async clear() {
      await rm(file, { force: true }).catch(() => {});
    },
  };
}

/** In-memory store, for the tests. */
export function createMemoryTokenStore(initial) {
  let saved = initial;
  return {
    async load(email) {
      return saved?.account === accountKey(email) ? saved.tokens : undefined;
    },
    async save(email, tokens) {
      saved = { account: accountKey(email), tokens };
    },
    async clear() {
      saved = undefined;
    },
    get saved() {
      return saved;
    },
  };
}
