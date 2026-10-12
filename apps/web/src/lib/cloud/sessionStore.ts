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
 *
 * ONE owner. The session used to exist twice: here, in a module-level
 * `cached`, and again inside the React store (useCloudSession). The two
 * drifted — `markSynced` stamped `lastSyncAt` into this copy while the page
 * rendered the other, so "Last sync" read "not yet" until a reload, and the
 * fix that shipped was a `refreshSession()` sprinkled through the sync path to
 * copy one into the other by hand. There is now a single zustand store, and
 * every writer below goes through `useSessionStore.setState`. Anything React
 * subscribes to is therefore correct the instant the write happens, with no
 * refresh call and no second source of truth.
 */

import { create } from 'zustand';

import { secureGet, secureRemove, secureSet } from './secureStore';
import type { CloudAuthResponse, CloudSessionState, CloudUser } from './types';

const ACCESS_KEY = 'np.cloud.access';
const REFRESH_KEY = 'np.cloud.refresh';
const USER_KEY = 'np.cloud.user';
const SESSION_ID_KEY = 'np.cloud.sessionId';
const DEVICE_ID_KEY = 'np.cloud.deviceId';
const LAST_SYNC_KEY = 'np.cloud.lastSyncAt';

const ACCESS_TTL_MS = 30 * 60 * 1000;

interface SessionState {
  /** The session, or null when signed out. The only copy in the app. */
  session: CloudSessionState | null;
  /**
   * False means "no memory of storage" — the next read goes back to
   * localStorage. `clearSession` drops it that way on purpose: signing out
   * must not leave a memo that shadows whatever storage says afterwards.
   */
  hydrated: boolean;
}

export const useSessionStore = create<SessionState>(() => ({ session: null, hydrated: false }));

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

function loadFromStorage(): CloudSessionState | null {
  // Refresh token, user record and session id are read through
  // the secure store: on desktop they are DPAPI-protected blobs
  // decrypted at prime time; in web mode this is a plain
  // localStorage read, unchanged.
  const refreshToken = secureGet(REFRESH_KEY);
  const userJson = secureGet(USER_KEY);
  const sessionId = secureGet(SESSION_ID_KEY);
  if (!refreshToken || !userJson || !sessionId) return null;
  try {
    const user = JSON.parse(userJson) as CloudUser;
    // The access token lives in sessionStorage (dies with the app); the
    // refresh token survives in localStorage. After a restart the session is
    // restored WITHOUT a live access token — hasFreshAccess() is then false
    // and the first cloud request silently refreshes. That is what makes
    // "open the app, still logged in" work.
    const accessToken = safeGet(sessionStorage, ACCESS_KEY) ?? '';
    return {
      user,
      accessToken,
      refreshToken,
      sessionId,
      accessExpiresAt: accessToken ? Date.now() + ACCESS_TTL_MS : 0,
      lastSyncAt: Number(secureGet(LAST_SYNC_KEY) ?? 0) || null,
    };
  } catch {
    return null;
  }
}

/** Read storage into the store, once. React components call this via `init`. */
export function initSession(): void {
  if (useSessionStore.getState().hydrated) return;
  useSessionStore.setState({ session: loadFromStorage(), hydrated: true });
}

function persist(state: CloudSessionState): void {
  safeSet(sessionStorage, ACCESS_KEY, state.accessToken);
  secureSet(REFRESH_KEY, state.refreshToken);
  secureSet(USER_KEY, JSON.stringify(state.user));
  secureSet(SESSION_ID_KEY, state.sessionId);
  if (state.lastSyncAt) secureSet(LAST_SYNC_KEY, String(state.lastSyncAt));
}

/** Current session or null when signed out. */
export function currentSession(): CloudSessionState | null {
  initSession();
  return useSessionStore.getState().session;
}

/** True when a session exists and its access token is not near expiry. */
export function hasFreshAccess(): boolean {
  const s = currentSession();
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
  persist(state);
  useSessionStore.setState({ session: state, hydrated: true });
  return state;
}

/** Persist rotated tokens after a refresh round-trip. */
export function adoptRefresh(newAccessToken: string, newRefreshToken: string, sessionId: string): void {
  const s = currentSession();
  if (!s) return;
  const next = { ...s, accessToken: newAccessToken, refreshToken: newRefreshToken, sessionId, accessExpiresAt: Date.now() + ACCESS_TTL_MS };
  persist(next);
  useSessionStore.setState({ session: next, hydrated: true });
}

/** Record a completed sync.
 *
 * This is the one write that has to reach React: the account page renders
 * `lastSyncAt`, so the stamp goes into the store itself rather than storage
 * alone. A subscriber is notified by the same `setState` that persists it.
 */
export function markSynced(at: number): void {
  const s = currentSession();
  if (!s) return;
  useSessionStore.setState({ session: { ...s, lastSyncAt: at }, hydrated: true });
  secureSet(LAST_SYNC_KEY, String(at));
}

/** Sign out locally; `keepDevice` preserves the anonymous device id. */
export function clearSession(): void {
  safeRemove(sessionStorage, ACCESS_KEY);
  secureRemove(REFRESH_KEY);
  secureRemove(USER_KEY);
  secureRemove(SESSION_ID_KEY);
  secureRemove(LAST_SYNC_KEY);
  // `hydrated: false` drops the memo: the next read comes from storage, which
  // is how a sign-out followed by a restart (or by storage being rewritten
  // underneath us) resolves to whatever is actually persisted.
  useSessionStore.setState({ session: null, hydrated: false });
}

/** Records the user identity without touching tokens (account info refresh). */
export function updateUser(user: CloudUser): void {
  const s = currentSession();
  if (!s) return;
  const next = { ...s, user };
  persist(next);
  useSessionStore.setState({ session: next, hydrated: true });
}