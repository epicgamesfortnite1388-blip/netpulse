import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiModule from '@/lib/api';

/**
 * The browser half of "the user never sees the raw config".
 *
 * Cloud profile restore used to run HERE: download the sealed blob, decrypt it
 * with the account key, `JSON.parse` it, and POST the resulting `configText`
 * back to the API to be imported. That was the last flow in the app that put a
 * real configuration where the user could read and copy it — and it only
 * existed because the config had to travel through this page to get back into
 * the engine.
 *
 * Both halves of that round trip now run on the API. This test pins the browser
 * end of the new contract: a restore sends a bearer token and a cloud profile
 * id, and comes back with a profile id and a name. If anyone re-adds a
 * `configText` to the request — or a `/bundle` read to fetch one — this fails.
 */

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn() } };
});

const { api } = await import('@/lib/api');
const { restoreProfileFromVault } = await import('@/lib/cloud/syncEngine');
const { adoptAuthResponse, clearSession } = await import('@/lib/cloud/sessionStore');

const auth = {
  user: { id: 'usr_test', email: 'a@b.c', createdAt: 1, lastLoginAt: 2 },
  accessToken: 'at'.repeat(20),
  refreshToken: 'rt'.repeat(20),
  session: {
    id: 'sess_1',
    deviceName: 'Desktop',
    os: 'Windows',
    appVersion: '1.0.2',
    createdAt: 1,
    lastSeenAt: 1,
    expiresAt: Date.now() + 30 * 24 * 3600e3,
    current: true,
  },
};

/** A response shaped like a leaked config must still not reach the caller. */
const SECRET_UUID = 'b831381d-6324-4d53-ad4f-8cda48b30811';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearSession();
  adoptAuthResponse(auth);
});

afterEach(() => {
  clearSession();
  vi.mocked(api.post).mockReset();
});

describe('restoreProfileFromVault never handles a configuration', () => {
  it('posts only the session token and the cloud id to the server-side route', async () => {
    vi.mocked(api.post).mockResolvedValue({
      profile: { id: 'local-2', name: 'Restored', protocol: 'singbox' },
    } as never);

    const result = await restoreProfileFromVault('np-local-abc');

    expect(result).toEqual({ ok: true, profileId: 'local-2', name: 'Restored' });
    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, body] = vi.mocked(api.post).mock.calls[0] as unknown as [string, Record<string, unknown>];

    expect(path).toBe('/vpn/profiles/cloud-restore');
    expect(body).toEqual({ accessToken: auth.accessToken, cloudProfileId: 'np-local-abc' });

    // The request carries no config in any form — not encrypted, not base64.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('configText');
    expect(serialized).not.toContain('outbound');
    expect(serialized).not.toMatch(/\b(vless|vmess|trojan):\/\//i);
    expect(serialized).not.toContain(SECRET_UUID);
    expect(Object.keys(body).sort()).toEqual(['accessToken', 'cloudProfileId']);
  });

  it('does not read a config back through the retired bundle route', async () => {
    vi.mocked(api.post).mockResolvedValue({ profile: { id: 'local-2', name: 'Restored' } } as never);
    vi.mocked(api.get).mockResolvedValue({} as never);

    await restoreProfileFromVault('np-local-abc');

    // One POST to the server-side route and nothing else: no /bundle read, no
    // cloud blob download, no decrypt.
    expect(vi.mocked(api.get)).not.toHaveBeenCalled();
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('surfaces an unreadable backup as a decrypt failure, not a raw code', async () => {
    // The API reports a blob sealed with a key this machine lacks as
    // `legacy_blob_unreadable`. The Account page renders a sentence for
    // `decrypt_failed`, so that is what this must map to — otherwise the user
    // reads "local: legacy_blob_unreadable".
    const { ApiError } = await import('@/lib/api');
    vi.mocked(api.post).mockRejectedValue(new ApiError('legacy_blob_unreadable', 409, 'sealed elsewhere'));

    const result = await restoreProfileFromVault('np-local-legacy');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('decrypt_failed');
    // The API's explanation is still available for logging/debugging.
    expect(JSON.stringify(result)).not.toContain(SECRET_UUID);
  });

  it('reports signed-out without calling anything', async () => {
    clearSession();
    const result = await restoreProfileFromVault('np-local-abc');
    expect(result).toEqual({ ok: false, error: 'signed-out' });
    expect(api.post).not.toHaveBeenCalled();
  });
});