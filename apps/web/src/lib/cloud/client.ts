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
 * guessing. See `describeEgressFailure`.
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

const TIMEOUT_MS = 15_000;

interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  json?: unknown;
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
const EGRESS_REASONS: ReadonlySet<string> = new Set([
  'proxy_unreachable',
  'direct_unreachable',
  'timeout',
  'tls_failed',
  'socks_unsupported',
]);

/**
 * Why a cloud call could not be delivered, phrased for the person who has to
 * fix it.
 *
 * The sidecar classifies the transport failure; this turns that into a sentence
 * that names the actual problem. The old generic "check your connection" was
 * actively misleading: the most common cause by far was a proxy that was never
 * consulted, which the user could only fix by *using* it — which the app was
 * not doing.
 */
export function describeEgressFailure(reason: string, hint: string | undefined): string {
  const proxy = hint?.startsWith('proxy: ') ? hint.slice('proxy: '.length) : null;
  switch (reason) {
    case 'proxy_unreachable':
      return `Could not reach your proxy at ${proxy ?? 'the system proxy address'}. Turn the tunnel on (or start your proxy client), then try again.`;
    case 'timeout':
      return proxy
        ? `The cloud did not answer through ${proxy} in time. The tunnel may not be routing this app.`
        : 'The cloud did not answer in time. It is blocked or slow on this network.';
    case 'tls_failed':
      return 'The encrypted connection was rejected — this connection is being filtered. Turn on your VPN/tunnel and try again.';
    case 'socks_unsupported':
      return 'Your system proxy is a SOCKS listener, which this app cannot route the cloud through. Turn on TUN mode, or set an HTTP proxy.';
    default:
      return 'Could not reach the cloud — it is blocked or offline on this network. Turning on a VPN or tunnel usually fixes this.';
  }
}

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
      timeoutMs: TIMEOUT_MS,
    });
    return asResponse(result);
  } catch (err) {
    // The sidecar reports a delivery failure as `502 <egress reason>`. That
    // reason is the whole point — it is what tells the user to start their
    // tunnel instead of debugging their connection — so it must survive.
    const apiErr = err instanceof ApiError ? err : null;
    const code = apiErr?.code ?? '';
    if (EGRESS_REASONS.has(code)) {
      throw new CloudError(code, 0, describeEgressFailure(code, apiErr?.hint));
    }
    // Anything else is a failure talking to the sidecar itself, which is on
    // loopback and never blocked — so the network is not the explanation.
    throw new CloudError(
      'network_error',
      0,
      'The local backend did not respond, so the cloud request was never sent.',
    );
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
