/**
 * Cloud session store — the desktop's account credentials, local-only.
 *
 * Access token: 30 min TTL, kept in memory + sessionStorage (survives a
 * reload, dies with the app). Refresh token: 30 day TTL, kept in localStorage
 * so the app can silently re-authenticate across restarts — this is what
 * makes "open the app, still logged in" work. Neither token is a Cloudflare
 * credential; both are revocable end-user session tokens, and every failure
 * path drops them rather than retrying into a confusing state.
 *
 * The device id is a random UUID persisted locally — informational only
 * (device roster), never an auth credential.
 */

import type { CloudAuthResponse, CloudSessionState, CloudUser } from './types';

const ACCESS_KEY = 'np.cloud.access';
const REFRESH_KEY = 'np.cloud.refresh';
const USER_KEY = 'np.cloud.user';
const SESSION_ID_KEY = 'np.cloud.sessionId';
const DEVICE_ID_KEY = 'np.cloud.deviceId';
const LAST_SYNC_KEY = 'np.cloud.lastSyncAt';

const ACCESS_TTL_MS = 30 * 60 * 1000;

let cached: CloudSessionState | null = null;

function safeGet(store: Storage, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(store: Storage, key: string, value: string): void {
  try {
    store.setItem(key, value);
  } catch {
    // Private-browsing/quota failures degrade to memory-only tokens.
  }
}

function safeRemove(store: Storage, key: string): void {
  try {
    store.removeItem(key);
  } catch {
    // ignore
  }
}

export function deviceId(): string {
  let id = safeGet(localStorage, DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    safeSet(localStorage, DEVICE_ID_KEY, id);
  }
  return id;
}

function readState(): CloudSessionState | null {
  if (cached) return cached;
  const refreshToken = safeGet(localStorage, REFRESH_KEY);
  const userJson = safeGet(localStorage, USER_KEY);
  const sessionId = safeGet(localStorage, SESSION_ID_KEY);
  if (!refreshToken || !userJson || !sessionId) return null;
  try {
    const user = JSON.parse(userJson) as CloudUser;
    // The access token lives in sessionStorage (dies with the app); the
    // refresh token survives in localStorage. After a restart the session is
    // restored WITHOUT a live access token — hasFreshAccess() is then false
    // and the first cloud request silently refreshes. That is what makes
    // "open the app, still logged in" work.
    const accessToken = safeGet(sessionStorage, ACCESS_KEY) ?? '';
    cached = {
      user,
      accessToken,
      refreshToken,
      sessionId,
      accessExpiresAt: accessToken ? Date.now() + ACCESS_TTL_MS : 0,
      lastSyncAt: Number(safeGet(localStorage, LAST_SYNC_KEY) ?? 0) || null,
    };
    return cached;
  } catch {
    return null;
  }
}

function writeState(state: CloudSessionState): void {
  cached = state;
  safeSet(sessionStorage, ACCESS_KEY, state.accessToken);
  safeSet(localStorage, REFRESH_KEY, state.refreshToken);
  safeSet(localStorage, USER_KEY, JSON.stringify(state.user));
  safeSet(localStorage, SESSION_ID_KEY, state.sessionId);
  if (state.lastSyncAt) safeSet(localStorage, LAST_SYNC_KEY, String(state.lastSyncAt));
}

/** Current session or null when signed out. */
export function currentSession(): CloudSessionState | null {
  return readState();
}

/** True when a session exists and its access token is not near expiry. */
export function hasFreshAccess(): boolean {
  const s = readState();
  return s !== null && s.accessExpiresAt - Date.now() > 60_000;
}

/** Store the tokens from a login/register response. */
export function adoptAuthResponse(auth: CloudAuthResponse): CloudSessionState {
  const state: CloudSessionState = {
    user: auth.user,
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    sessionId: auth.session.id,
    accessExpiresAt: Date.now() + ACCESS_TTL_MS,
    lastSyncAt: null,
  };
  writeState(state);
  return state;
}

/** Persist rotated tokens after a refresh round-trip. */
export function adoptRefresh(newAccessToken: string, newRefreshToken: string, sessionId: string): void {
  const s = readState();
  if (!s) return;
  writeState({ ...s, accessToken: newAccessToken, refreshToken: newRefreshToken, sessionId, accessExpiresAt: Date.now() + ACCESS_TTL_MS });
}

export function markSynced(at: number): void {
  const s = readState();
  if (!s) return;
  cached = { ...s, lastSyncAt: at };
  safeSet(localStorage, LAST_SYNC_KEY, String(at));
}

/** Sign out locally; `keepDevice` preserves the anonymous device id. */
export function clearSession(): void {
  cached = null;
  safeRemove(sessionStorage, ACCESS_KEY);
  safeRemove(localStorage, REFRESH_KEY);
  safeRemove(localStorage, USER_KEY);
  safeRemove(localStorage, SESSION_ID_KEY);
  safeRemove(localStorage, LAST_SYNC_KEY);
}

/** Records the user identity without touching tokens (account info refresh). */
export function updateUser(user: CloudUser): void {
  const s = readState();
  if (!s) return;
  writeState({ ...s, user });
}
