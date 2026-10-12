/**
 * Vault key lifecycle — one owner for "does this device hold the E2E key?".
 *
 * The derived key is cached in localStorage keyed by account so a restarted
 * app (silent refresh, no password entry) keeps syncing. A cleared storage
 * means LOCKED: the Account page offers password re-entry (unlock), and sync
 * skips encrypted backup rather than failing. `ensureVaultKeyForAccount` is
 * called at login/register; failures there are non-fatal and leave the vault
 * locked with an honest status.
 */
import { cloudApi } from './client';
import { currentSession } from './sessionStore';
import { deriveRawKey, importRawKey, randomSaltB64 } from './profileVaultCrypto';
import { secureGet, secureRemove, secureSet } from './secureStore';

const KEY_PREFIX = 'np.cloud.e2eKey.';
const SALT_PREF = 'e2e.salt';

export type VaultKeyState = 'ready' | 'locked' | 'signed-out';

function cachedRaw(userId: string): string | null {
  // DPAPI-protected on desktop (secureStore); plaintext in web mode.
  return secureGet(KEY_PREFIX + userId);
}

function cacheRaw(userId: string, rawB64: string): void {
  secureSet(KEY_PREFIX + userId, rawB64);
}

export function clearVaultKey(userId: string): void {
  secureRemove(KEY_PREFIX + userId);
}

/**
 * Load the key for the current session, deriving nothing. `ready` when this
 * device holds the key, `locked` when a session exists without it.
 */
export async function loadVaultKey(): Promise<{ state: VaultKeyState; key: CryptoKey | null }> {
  const session = currentSession();
  if (!session) return { state: 'signed-out', key: null };
  const rawB64 = cachedRaw(session.user.id);
  if (!rawB64) return { state: 'locked', key: null };
  try {
    const bin = atob(rawB64);
    const raw = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
    return { state: 'ready', key: await importRawKey(raw) };
  } catch {
    return { state: 'locked', key: null };
  }
}

/**
 * Derive and cache the vault key from a password, creating + uploading the
 * account salt when this is the first device. Returns the final state.
 */
export async function ensureVaultKeyForAccount(password: string): Promise<VaultKeyState> {
  const session = currentSession();
  if (!session) return 'signed-out';
  const userId = session.user.id;
  try {
    const prefs = await cloudApi.preferences();
    let salt = prefs.preferences.find((p) => p.key === SALT_PREF)?.value ?? null;
    if (!salt) {
      salt = randomSaltB64();
      await cloudApi.putPreference(SALT_PREF, salt);
    }
    const raw = await deriveRawKey(password, salt);
    cacheRaw(userId, btoa(String.fromCharCode(...raw)));
    return 'ready';
  } catch {
    // Cloud unreachable or salt fetch failed: stay locked; unlock later.
    return cachedRaw(userId) ? 'ready' : 'locked';
  }
}
