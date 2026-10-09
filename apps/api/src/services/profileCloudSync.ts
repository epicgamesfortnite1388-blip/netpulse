import { CLOUD_API_BASE, assertCloudUrl, egressFetch } from './egressProxy';
import { buildProfileBundle } from './profileBundle';

import type { CloudProfilePayload, ProfileCloudVault } from './profileCloudVault';
import type { EgressError } from './egressProxy';
import type { BundleError } from './profileBundle';
import type { VpnRegistry } from '../vpn/vpnService';

/**
 * Cloud profile backup, end to end on this machine.
 *
 * Before: the webview asked the API for a profile's `configText`, encrypted it
 * with the password-derived E2E key, uploaded the blob, and — to restore —
 * downloaded it, decrypted it **into the page**, and posted the plaintext back
 * to the API to re-import. So restore could not happen without a config being
 * rendered where the user could read and copy it, which is the one thing this
 * whole change exists to prevent.
 *
 * Now: the API reads the config from the file vault, seals it, and uploads the
 * blob; on restore it pulls the blob, opens it, and writes the profile through
 * the engine's own import path. The client sends a bearer token and a profile
 * id. It receives a profile id and a name. There is no code path in this module
 * that returns `configText` to a caller.
 *
 * ## What this gives up
 *
 * The cloud copy is no longer end-to-end encrypted against *this* machine: the
 * API holds the seal key (see ProfileCloudVault for where it lives and why
 * that is a weakness). It is still opaque to the cloud operator and to anyone
 * reading only the cloud database. That is the honest trade for making restore
 * work without showing anyone a config.
 *
 * The upload still had plaintext crossing this API when the user pasted a
 * config in (`POST /vpn/profiles`); that is unchanged and out of scope here.
 */

const CLOUD_TIMEOUT_MS = 30_000;

/** Why a push or restore could not finish, in terms the UI can act on. */
export type ProfileCloudErrorCode =
  | 'cloud_unauthorized'
  | 'cloud_unreachable'
  | 'cloud_rejected'
  | 'not_found'
  | 'legacy_blob_unreadable'
  | 'profile_unsupported'
  | 'unknown';

export class ProfileCloudError extends Error {
  constructor(
    readonly code: ProfileCloudErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProfileCloudError';
  }
}

/** The cloud profile id used for a locally-stored profile. */
export const envelopeIdFor = (profileId: string): string => `np-local-${profileId}`;

interface CloudVaultRow {
  profileId: string;
  ciphertext: string;
  updatedAt: number;
}

interface CloudProfileRow {
  id: string;
  name: string;
  protocol: string;
  endpoint: string | null;
}

/**
 * One authenticated call to the Worker, through the same egress path sign-in
 * uses. The token is the caller's own cloud session; it is a credential that
 * crosses to the local API, not a config that leaves the machine.
 */
async function cloudCall<T>(
  accessToken: string,
  path: string,
  init: { method: 'GET' | 'PUT' | 'POST'; body?: unknown } = { method: 'GET' },
): Promise<T> {
  if (!accessToken.trim()) throw new ProfileCloudError('cloud_unauthorized', 'No cloud session was supplied.');

  let res;
  try {
    res = await egressFetch({
      url: assertCloudUrl(new URL(path, CLOUD_API_BASE).toString()).toString(),
      method: init.method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      timeoutMs: CLOUD_TIMEOUT_MS,
    });
  } catch (err) {
    const reason = (err as EgressError).reason ?? 'unknown';
    throw new ProfileCloudError('cloud_unreachable', `The cloud could not be reached (${reason}).`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new ProfileCloudError('cloud_unauthorized', 'The cloud rejected this session. Sign in again and retry.');
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ProfileCloudError('cloud_rejected', `The cloud refused the request (HTTP ${res.status}).`);
  }
  return JSON.parse(res.body) as T;
}

/** Turn a bundle-building failure into the same vocabulary as everything else. */
function fromBundleError(err: unknown): never {
  const code = (err as BundleError).code;
  if (code === 'not_found') throw new ProfileCloudError('not_found', 'That profile is not on this machine.');
  if (code === 'credential_missing') {
    throw new ProfileCloudError('profile_unsupported', 'The profile credential is no longer in the vault.');
  }
  if (code === 'config_missing') {
    throw new ProfileCloudError('profile_unsupported', 'The stored profile config file is missing.');
  }
  throw new ProfileCloudError('profile_unsupported', `This engine cannot be backed up (${code ?? 'unknown'}).`);
}

export interface ProfileCloudDeps {
  registry: VpnRegistry;
  vault: ProfileCloudVault;
}

export interface PushResult {
  envelopeId: string;
  name: string;
  protocol: string;
}

/**
 * Back up one local profile: read its real config from the file vault, seal it,
 * and push ciphertext plus metadata to the cloud.
 *
 * Returns what the UI needs to report success — and nothing that describes the
 * config.
 */
export async function pushProfileToCloud(
  deps: ProfileCloudDeps,
  profileId: string,
  accessToken: string,
): Promise<PushResult> {
  let bundle;
  try {
    bundle = buildProfileBundle(deps.registry, profileId);
  } catch (err) {
    fromBundleError(err);
  }

  const envelopeId = envelopeIdFor(profileId);
  const payload: CloudProfilePayload = {
    providerId: bundle.providerId,
    name: bundle.name,
    configText: bundle.configText,
  };
  const ciphertext = deps.vault.seal(envelopeId, payload);

  // Blob first: a crash between the two leaves an unreferenced blob, never a
  // profile row pointing at a config that was never uploaded.
  await cloudCall(accessToken, '/api/v1/profile-vaults', {
    method: 'PUT',
    body: { profileId: envelopeId, ciphertext, updatedAt: Date.now() },
  });
  await cloudCall(accessToken, '/api/v1/profiles', {
    method: 'PUT',
    body: {
      id: envelopeId,
      name: bundle.name,
      protocol: bundle.protocol,
      endpoint: bundle.endpoint ?? null,
      config: '{}',
      configVersion: 1,
    },
  });

  return { envelopeId, name: bundle.name, protocol: bundle.protocol };
}

export interface RestoreSource {
  envelopeId: string;
  name: string;
  payload: CloudProfilePayload;
}

/**
 * Fetch one cloud backup and open it here. Split out from the import so the
 * caller owns the profile-creation path — this function never creates anything.
 */
export async function fetchCloudProfile(
  deps: ProfileCloudDeps,
  cloudProfileId: string,
  accessToken: string,
): Promise<RestoreSource> {
  const { vaults } = await cloudCall<{ vaults: CloudVaultRow[] }>(accessToken, '/api/v1/profile-vaults');
  const row = vaults.find((v) => v.profileId === cloudProfileId);
  if (!row) throw new ProfileCloudError('not_found', 'That profile is not in the cloud backup.');

  const payload = deps.vault.open<CloudProfilePayload>(cloudProfileId, row.ciphertext);
  if (!payload || typeof payload.configText !== 'string') {
    throw new ProfileCloudError(
      'legacy_blob_unreadable',
      'This backup was encrypted on another device with an account key this machine does not hold. Re-sync it from a device that still has the key, or import the config again.',
    );
  }

  // Name is best-effort: the cloud row is authoritative for display, the sealed
  // payload for what gets imported.
  let name = payload.name;
  try {
    const { profiles } = await cloudCall<{ profiles: CloudProfileRow[] }>(accessToken, '/api/v1/profiles');
    name = profiles.find((p) => p.id === cloudProfileId)?.name ?? name;
  } catch {
    // Metadata is cosmetic here; a failure to read it must not block a restore
    // whose blob we already hold.
  }

  return { envelopeId: cloudProfileId, name, payload };
}

/** Every cloud backup id, so the caller can tombstone ones the device no longer has. */
export async function listCloudBackups(accessToken: string): Promise<CloudVaultRow[]> {
  const { vaults } = await cloudCall<{ vaults: CloudVaultRow[] }>(accessToken, '/api/v1/profile-vaults');
  return vaults;
}

/** Retire one cloud backup after it has been restored under a new id. */
export async function deleteCloudBackup(accessToken: string, envelopeId: string): Promise<void> {
  await cloudCall(accessToken, '/api/v1/profile-vaults/delete', {
    method: 'POST',
    body: { profileId: envelopeId },
  });
}

/** Tombstone the cloud's profile row so the inventory stops listing it. */
export async function tombstoneCloudProfile(
  accessToken: string,
  profileId: string,
  name: string,
  protocol: string,
): Promise<void> {
  await cloudCall(accessToken, '/api/v1/profiles', {
    method: 'PUT',
    body: { id: profileId, name, protocol, endpoint: null, config: '{}', configVersion: 1, deleted: true },
  });
}

/** Re-point the backup at a freshly created profile's id. */
export async function rekeyCloudProfile(
  accessToken: string,
  envelopeId: string,
  name: string,
  protocol: string,
  endpoint: string | null,
): Promise<void> {
  await cloudCall(accessToken, '/api/v1/profiles', {
    method: 'PUT',
    body: { id: envelopeId, name, protocol, endpoint, config: '{}', configVersion: 1 },
  });
}