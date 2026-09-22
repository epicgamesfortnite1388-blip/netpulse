/**
 * Cloud API shapes — mirrored from cloud/worker/src/api.ts.
 *
 * Kept as a literal mirror (not an import) on purpose: the Worker bundles with
 * wrangler under the workers toolchain while the desktop bundles under Vite,
 * and a cross-workspace import would couple two independent build graphs.
 * `test/cloudMirror.test.ts` asserts the mirror stays honest.
 */

export interface CloudUser {
  id: string;
  email: string;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface CloudSession {
  id: string;
  deviceName: string | null;
  os: string | null;
  appVersion: string | null;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  current: boolean;
}

export interface CloudAuthResponse {
  user: CloudUser;
  accessToken: string;
  refreshToken: string;
  session: CloudSession;
}

export interface CloudProfile {
  id: string;
  name: string;
  protocol: string;
  endpoint: string | null;
  config: string;
  configVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface CloudFavorite {
  nodeKey: string;
  label: string | null;
  createdAt: number;
}

export interface CloudPreference {
  key: string;
  value: string | null;
  updatedAt: number;
}

export interface CloudDevice {
  id: string;
  name: string;
  os: string | null;
  appVersion: string | null;
  firstSeenAt: number;
  lastActiveAt: number;
}

/** Error body shape from the Worker. */
export interface CloudErrorBody {
  error: { code: string; message: string };
  retryAfterSec?: number;
}

/** Machine state of the account + sync engine, persisted in local storage. */
export interface CloudSessionState {
  user: CloudUser;
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  accessExpiresAt: number;
  lastSyncAt: number | null;
}
