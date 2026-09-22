/**
 * Cloud API client — the desktop's only route to the Worker.
 *
 * Mirrors lib/api.ts conventions: consistent error envelope, single retry on
 * recoverable auth states. Differences it must handle: the Worker is a remote
 * origin (CORS applies; timeouts are real), the access token expires every 30
 * minutes (silent refresh via the stored refresh token), and a reused/rotated
 * refresh token kills the whole session chain (sign out locally, never loop).
 */

import {
  adoptAuthResponse,
  adoptRefresh,
  clearSession,
  currentSession,
  deviceId,
  hasFreshAccess,
} from './sessionStore';
import type {
  CloudAuthResponse,
  CloudDevice,
  CloudErrorBody,
  CloudFavorite,
  CloudPreference,
  CloudProfile,
  CloudSession,
  CloudUser,
} from './types';

export class CloudError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'CloudError';
  }
}

/** The production Worker. Config comes from the sidecar bootstrap in dev. */
export const CLOUD_API_BASE = 'https://netpulse-cloud.shuridehradin.workers.dev';

const TIMEOUT_MS = 15_000;

interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  json?: unknown;
  _retriedRefresh?: boolean;
}

async function rawFetch(path: string, options: RequestOptions, token: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${CLOUD_API_BASE}${path}`, {
    method: options.method,
    headers,
    body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return res;
}

async function parseError(res: Response): Promise<CloudError> {
  let code = `http_${res.status}`;
  let message = res.statusText || 'Cloud request failed';
  let retryAfterSec: number | undefined;
  try {
    const body = (await res.json()) as CloudErrorBody;
    if (body.error) {
      code = body.error.code;
      message = body.error.message;
    }
    retryAfterSec = body.retryAfterSec;
  } catch {
    // non-JSON error body (e.g. gateway HTML)
  }
  return new CloudError(code, res.status, message, retryAfterSec);
}

/** Device identity sent with every session-creating call. */
export function deviceDescriptor(): { name: string; os: string; appVersion: string } {
  return { name: `Desktop ${deviceId().slice(0, 8)}`, os: navigator.platform || 'Windows', appVersion: import.meta.env.PROD ? '1.0.2' : 'dev' };
}

/**
 * Authenticated request. Refreshes the access token once when stale or when
 * the Worker answers 401. Three distinct failure modes, because the caller
 * must treat them differently:
 *  - `network_error`: the cloud is unreachable — offline, keep local state,
 *    the sync engine retries later (never signs the user out).
 *  - `signed_out`: refresh rejected (reused/invalid token) — local session
 *    is already cleared; the UI shows the welcome gate.
 */
async function request<T>(path: string, options: RequestOptions): Promise<T> {
  let res: Response;
  if (!hasFreshAccess()) {
    const r = await tryRefresh();
    if (r === 'offline') throw new CloudError('network_error', 0, 'Cloud is unreachable — working offline');
    if (r === 'dead') throw new CloudError('signed_out', 401, 'Sign in again to continue');
  }
  const session = currentSession();
  res = await rawFetch(path, options, session?.accessToken ?? null);

  if (res.status === 401 && !options._retriedRefresh) {
    const r = await tryRefresh();
    if (r === 'offline') throw new CloudError('network_error', 0, 'Cloud is unreachable — working offline');
    if (r === 'dead') throw new CloudError('signed_out', 401, 'Sign in again to continue');
    const retry = currentSession();
    res = await rawFetch(path, options, retry?.accessToken ?? null);
  }
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

type RefreshOutcome = 'ok' | 'offline' | 'dead';

async function tryRefresh(): Promise<RefreshOutcome> {
  const s = currentSession();
  if (!s) return 'dead';
  let res: Response;
  try {
    res = await rawFetch('/api/v1/auth/refresh', { method: 'POST', json: { refreshToken: s.refreshToken } }, null);
  } catch {
    return 'offline'; // network failure: keep local state, sync retries later
  }
  if (!res.ok) {
    const err = await parseError(res);
    if (err.code === 'refresh_reused' || err.code === 'invalid_refresh') clearSession();
    return 'dead';
  }
  const body = (await res.json()) as { accessToken: string; refreshToken: string; session: CloudSession };
  adoptRefresh(body.accessToken, body.refreshToken, body.session.id);
  return 'ok';
}

/* ------------------------------ public auth ------------------------------ */

export const cloudAuth = {
  async register(email: string, password: string): Promise<CloudAuthResponse> {
    const auth = (await rawFetch('/api/v1/auth/register', { method: 'POST', json: { email, password, device: deviceDescriptor() } }, null).then(async (r) => {
      if (!r.ok) throw await parseError(r);
      return (await r.json()) as CloudAuthResponse;
    }));
    adoptAuthResponse(auth);
    return auth;
  },

  async login(email: string, password: string): Promise<CloudAuthResponse> {
    const auth = (await rawFetch('/api/v1/auth/login', { method: 'POST', json: { email, password, device: deviceDescriptor() } }, null).then(async (r) => {
      if (!r.ok) throw await parseError(r);
      return (await r.json()) as CloudAuthResponse;
    }));
    adoptAuthResponse(auth);
    return auth;
  },

  async logout(): Promise<void> {
    const s = currentSession();
    if (s) {
      try {
        await rawFetch('/api/v1/auth/logout', { method: 'POST' }, s.accessToken);
      } catch {
        // Best-effort server revoke; local state is cleared regardless.
      }
    }
    clearSession();
  },

  /** Probe reachability without credentials — the offline gate. */
  async health(): Promise<boolean> {
    try {
      const res = await rawFetch('/api/v1/health', { method: 'GET' }, null);
      return res.ok;
    } catch {
      return false;
    }
  },
};

/* --------------------------- authenticated reads -------------------------- */

export const cloudApi = {
  account: () => request<{ user: CloudUser }>('/api/v1/account', { method: 'GET' }),
  sessions: () => request<{ sessions: CloudSession[] }>('/api/v1/account/sessions', { method: 'GET' }),
  revokeSession: (sessionId: string) =>
    request<{ ok: boolean }>('/api/v1/account/sessions/revoke', { method: 'POST', json: { sessionId } }),
  revokeAll: () => request<{ ok: boolean; revoked: number }>('/api/v1/account/sessions/all', { method: 'DELETE' }),
  revokeCurrent: () => request<{ ok: boolean }>('/api/v1/account/sessions/current', { method: 'DELETE' }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>('/api/v1/account/password', { method: 'POST', json: { currentPassword, newPassword } }),
  deleteAccount: () => request<{ ok: boolean }>('/api/v1/account', { method: 'DELETE' }),
  devices: () => request<{ devices: CloudDevice[] }>('/api/v1/devices', { method: 'GET' }),
  profiles: () => request<{ profiles: CloudProfile[] }>('/api/v1/profiles', { method: 'GET' }),
  putProfile: (body: unknown) => request<{ ok: boolean }>('/api/v1/profiles', { method: 'PUT', json: body }),
  favorites: () => request<{ favorites: CloudFavorite[] }>('/api/v1/favorites', { method: 'GET' }),
  putFavorite: (nodeKey: string, label: string | null) =>
    request<{ ok: boolean }>('/api/v1/favorites', { method: 'PUT', json: { nodeKey, label } }),
  preferences: () => request<{ preferences: CloudPreference[] }>('/api/v1/preferences', { method: 'GET' }),
  putPreference: (key: string, value: string | null) =>
    request<{ ok: boolean }>('/api/v1/preferences', { method: 'PUT', json: { key, value } }),
  settings: () => request<{ payload: string; updatedAt: number }>('/api/v1/settings', { method: 'GET' }),
  putSettings: (payload: string, updatedAt: number) =>
    request<{ ok: boolean; updatedAt: number }>('/api/v1/settings', { method: 'PUT', json: { payload, updatedAt } }),
};
