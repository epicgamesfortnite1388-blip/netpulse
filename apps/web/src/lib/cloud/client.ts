/**
 * Cloud API client — the desktop's only route to the Worker.
 *
 * Mirrors lib/api.ts conventions: consistent error envelope, single retry on
 * recoverable auth states. Differences it must handle: the Worker is a remote
 * origin (CORS applies; timeouts are real), the access token expires every 30
 * minutes (silent refresh via the stored refresh token), and a reused/rotated
 * refresh token kills the whole session chain (sign out locally, never loop).
 *
 * Every request goes through the local sidecar (`POST /api/v1/cloud/egress`),
 * NOT straight out of the webview. A webview `fetch` cannot honour a system
 * proxy, so in Iran — where the Worker is commonly blocked directly but the
 * user already has a tunnel publishing one — sign-in and Telegram sync failed
 * with "check your connection" while the proxy went entirely unused. The
 * sidecar owns the proxy decision (apps/api/src/services/egressProxy.ts) and
 * reports *why* a call failed, so the UI can name the cause instead of
 * guessing. That sentence is written in ONE place — apps/api/src/services/
 * egressProxy.ts — and passed through here unchanged.
 */

import { ApiError, api } from '@/lib/api';
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

// The cloud origin deliberately does NOT live here. It is owned by the sidecar
// (apps/api/src/services/egressProxy.ts), which is what builds the URL the
// request is actually sent to; a second copy in the webview would be a second
// place to update and a second thing to disagree about.

/**
 * Time budgets, chosen by WHO IS WAITING — not by one constant.
 *
 * A blocked network used to cost the user 15s of unexplained "Working…" before
 * the app said anything (measured on the packaged build: 15.2s), which is the
 * worst possible answer on a filtered network: long enough to look broken, and
 * it gave no way to tell a dead proxy from a slow link.
 *
 *   interactive — a person is watching a spinner. Answer fast and name the
 *                 cause; a link that needs longer can be retried knowingly.
 *   patient     — they pressed "Sign in" again, i.e. chose to wait. A slow but
 *                 working tunnel (a long VPN handshake over a mobile link) gets
 *                 the room it needs, without any single attempt ever costing
 *                 the old 15s.
 *   background  — nobody is waiting (sync runs on a timer). The long window is
 *                 free here, and it keeps a slow link from dropping a sync
 *                 cycle that would have succeeded.
 *
 * The diagnosis is identical at every budget: the sidecar's sentence naming the
 * proxy is passed through untouched. A shorter wait never becomes a vaguer
 * answer.
 */
export const CLOUD_TIMEOUT = {
  interactive: 5_000,
  patient: 10_000,
  background: 15_000,
} as const;

/** The budget a request uses unless its caller names one. */
let defaultTimeoutMs: number = CLOUD_TIMEOUT.interactive;

/**
 * Run `fn` with the background budget — for unattended work, where waiting
 * costs the user nothing and a dropped sync cycle is a real loss. Scoped and
 * restored even if `fn` throws; the sign-in path never opts into it.
 */
export async function withBackgroundBudget<T>(fn: () => Promise<T>): Promise<T> {
  const previous = defaultTimeoutMs;
  defaultTimeoutMs = CLOUD_TIMEOUT.background;
  try {
    return await fn();
  } finally {
    defaultTimeoutMs = previous;
  }
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  json?: unknown;
  /** Overrides the default budget for this one request. */
  timeoutMs?: number;
  _retriedRefresh?: boolean;
}

/**
 * What the sidecar answers for a cloud call: the upstream status, the few
 * headers worth keeping, and the body verbatim.
 */
interface EgressResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * A response-shaped object over the sidecar's answer.
 *
 * The rest of this module only ever needs `ok`, `status`, `statusText` and
 * `json()`, so the egress hop does not have to fake a real `Response` — and
 * pretending to would hide that these bodies came from somewhere else.
 */
function asResponse(result: EgressResult): Response {
  const status = result.status;
  const text = result.body ?? '';
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: new Headers(result.headers ?? {}),
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
  } as unknown as Response;
}

/**
 * The transport outcomes the sidecar reports, and nothing else. A code outside
 * this set means the sidecar itself failed, which is a different problem with a
 * different fix.
 */
/**
 * The sidecar (apps/api/src/services/egressProxy.ts) decides AND words why a
 * call could not be delivered. This module keeps no second copy of those
 * sentences — it kept one, and the two drifted until a SOCKS listener asking
 * for a password was reported to the user as "restart your proxy client".
 *
 * What it does keep is one bit: whether the failure was an egress/transport
 * one. For those the sidecar's sentence is exactly right and passes through.
 * For anything else — a 500 from the relay, a validation error — the sidecar's
 * message is about the backend, not about the user's network, and showing
 * `SQLITE_CONSTRAINT: UNIQUE failed: users.email` in the sign-in form is both
 * noise and a small disclosure. Those get one local message of our own.
 */
const EGRESS_REASONS: ReadonlySet<string> = new Set([
  'proxy_unreachable',
  'direct_unreachable',
  'timeout',
  'tls_failed',
  'socks_failed',
  'socks_unsupported',
]);

/** A failure talking to the sidecar, which is on loopback and never blocked. */
const LOCAL_BACKEND_FAILURE =
  'The local backend did not respond, so the cloud request was never sent.';

/**
 * One cloud request, delivered by the sidecar through the resolved proxy.
 *
 * The client sends a *path*, never a URL: the sidecar builds the absolute URL
 * from its own cloud origin, so this cannot be used to reach anything else.
 */
async function rawFetch(path: string, options: RequestOptions, token: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.json !== undefined) headers['Content-Type'] = 'application/json';

  try {
    const result = await api.post<EgressResult>('/cloud/egress', {
      path,
      method: options.method,
      headers,
      body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
      timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
    });
    return asResponse(result);
  } catch (err) {
    // The sidecar owns the wording; this side owns the decision to show it.
    const apiErr = err instanceof ApiError ? err : null;
    if (apiErr && EGRESS_REASONS.has(apiErr.code)) {
      throw new CloudError(apiErr.code, 0, apiErr.message || 'Could not reach the cloud service.');
    }
    throw new CloudError('network_error', 0, LOCAL_BACKEND_FAILURE);
  }
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
  async register(email: string, password: string, timeoutMs?: number): Promise<CloudAuthResponse> {
    const auth = (await rawFetch('/api/v1/auth/register', { method: 'POST', json: { email, password, device: deviceDescriptor() }, timeoutMs }, null).then(async (r) => {
      if (!r.ok) throw await parseError(r);
      return (await r.json()) as CloudAuthResponse;
    }));
    adoptAuthResponse(auth);
    return auth;
  },

  async login(email: string, password: string, timeoutMs?: number): Promise<CloudAuthResponse> {
    const auth = (await rawFetch('/api/v1/auth/login', { method: 'POST', json: { email, password, device: deviceDescriptor() }, timeoutMs }, null).then(async (r) => {
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
  vaults: () =>
    request<{ vaults: Array<{ profileId: string; ciphertext: string; updatedAt: number }> }>('/api/v1/profile-vaults', { method: 'GET' }),
  putVault: (profileId: string, ciphertext: string, updatedAt: number) =>
    request<{ ok: boolean }>('/api/v1/profile-vaults', { method: 'PUT', json: { profileId, ciphertext, updatedAt } }),
  deleteVault: (profileId: string) =>
    request<{ ok: boolean; removed: boolean }>('/api/v1/profile-vaults/delete', { method: 'POST', json: { profileId } }),
  // NetPulse <-> Telegram linking (bot-verified entitlements; see
  // docs/netpulse-integration.md in the bot repo). The worker derives all
  // identity from the session; the client never supplies a Telegram id.
  netpulse: {
    link: () =>
      request<{ ok: boolean; token: string; deepLink: string; expiresAt: number }>('/api/v1/account/telegram/link', {
        method: 'POST',
        json: {},
      }),
    confirm: (code: string) =>
      request<{ ok: boolean }>('/api/v1/account/telegram/link/confirm', { method: 'POST', json: { code } }),
    status: () =>
      request<{
        ok: boolean;
        connected: boolean;
        telegram_user_id: number | null;
        linked_at: number | null;
        last_synced_at: number | null;
        last_sync_status: string | null;
      }>('/api/v1/account/telegram', { method: 'GET' }),
    unlink: () => request<{ ok: boolean }>('/api/v1/account/telegram/unlink', { method: 'POST' }),
    syncStatus: () =>
      request<{ ok: boolean; lastSyncAt: number | null; error: string | null }>('/api/v1/integrations/telegram/status', {
        method: 'POST',
      }),
    sync: () =>
      request<{ ok: boolean; subscriptions: NetpulseSubscription[] }>('/api/v1/integrations/telegram/sync', { method: 'POST' }),
    subscriptions: () => request<{ subscriptions: NetpulseSubscription[] }>('/api/v1/subscriptions', { method: 'GET' }),
  },
};

/** The safe entitlement model — the ONLY subscription projection NetPulse shows. */
export interface NetpulseSubscription {
  id: string;
  plan: string;
  status: string;
  started_at: string | null;
  expiration_time: string | null;
  auto_renew: boolean;
  total_gb: number;
  used_gb: number;
  ip_limit: number | null;
  config_updated_at: string | null;
}
