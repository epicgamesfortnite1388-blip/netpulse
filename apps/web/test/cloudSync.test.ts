import { beforeEach, describe, expect, it } from 'vitest';

import { VaultPutSchema } from '@cloud-contract';
import { CloudError } from '@/lib/cloud/client';
import {
  decryptProfileBlob,
  deriveRawKey,
  encryptProfileBlob,
  importRawKey,
  randomSaltB64,
  VaultCryptoError,
} from '@/lib/cloud/profileVaultCrypto';
import { classifySyncError, mergeSettings, pendingCount, queueFavorite, queuePreference } from '@/lib/cloud/syncEngine';
import { adoptAuthResponse, clearSession, currentSession, hasFreshAccess } from '@/lib/cloud/sessionStore';
import type { CloudAuthResponse } from '@/lib/cloud/types';

const auth = (over: Partial<CloudAuthResponse> = {}): CloudAuthResponse => ({
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
  ...over,
});

describe('settings merge policy (cloud sync)', () => {
  it('cloud section wins when its stamp is newer than the last sync', () => {
    const merged = mergeSettings(
      { general: { notifications: true }, vpn: { killSwitch: false } },
      { vpn: { killSwitch: true } },
      5_000,
      1_000,
    );
    expect(merged.vpn).toEqual({ killSwitch: true });
    expect(merged.general).toEqual({ notifications: true }); // local-only section kept
  });

  it('local section stands when the cloud stamp predates the last sync', () => {
    const merged = mergeSettings(
      { general: { notifications: true }, vpn: { killSwitch: false } },
      { vpn: { killSwitch: true } },
      1_000,
      5_000,
    );
    expect(merged.vpn).toEqual({ killSwitch: false });
  });

  it('a never-synced device adopts all cloud sections', () => {
    const merged = mergeSettings({ local: { a: 1 } }, { cloudA: { b: 2 }, cloudB: { c: 3 } }, 9_999, null);
    expect(merged.cloudA).toEqual({ b: 2 });
    expect(merged.cloudB).toEqual({ c: 3 });
    expect(merged.local).toEqual({ a: 1 });
  });

  it('never lets the cloud delete a local-only section', () => {
    const merged = mergeSettings({ general: { a: 1 } }, {}, 9_999, 1);
    expect(merged.general).toEqual({ a: 1 });
  });
});

describe('sync failure classification', () => {
  it('a network_error means offline: keep the session, retry later', () => {
    expect(classifySyncError(new (class extends Error {})('fetch failed'))).toEqual({ offline: true, message: 'fetch failed' });
  });

  it('a Worker answer (any code) is NOT offline — it is a real error to show', () => {
    const result = classifySyncError(new CloudError('conflict', 409, 'Request conflicts with existing data'));
    expect(result.offline).toBe(false);
  });
});

describe('offline queue', () => {
  beforeEach(() => localStorage.clear());

  it('queues favorites and preferences with a bounded count', () => {
    expect(pendingCount()).toBe(0);
    queueFavorite('node:x', null);
    queuePreference('theme', 'dark');
    expect(pendingCount()).toBe(2);
    for (let i = 0; i < 250; i++) queueFavorite(`node:${i}`, null);
    // bounded: the queue never grows without limit
    expect(pendingCount()).toBeLessThanOrEqual(200);
  });
});

describe('session store', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('round-trips an auth response and clears on sign-out', () => {
    expect(currentSession()).toBeNull();
    adoptAuthResponse(auth());
    const s = currentSession();
    expect(s?.user.email).toBe('a@b.c');
    expect(s?.sessionId).toBe('sess_1');
    expect(hasFreshAccess()).toBe(true);
    clearSession();
    expect(currentSession()).toBeNull();
    expect(hasFreshAccess()).toBe(false);
  });

  it('treats a partial store as signed out instead of crashing', () => {
    localStorage.setItem('np.cloud.refresh', 'orphan');
    expect(currentSession()).toBeNull();
  });
});

describe('session restore across restarts', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('a restart (empty sessionStorage, cold cache) still yields a session; first request must refresh', async () => {
    adoptAuthResponse(auth());
    // Simulate restart: the app persisted refresh/user/session in localStorage;
    // sessionStorage (and the module's memory cache) died with the process.
    const refresh = localStorage.getItem('np.cloud.refresh');
    const user = localStorage.getItem('np.cloud.user');
    const sessionId = localStorage.getItem('np.cloud.sessionId');
    clearSession();
    localStorage.setItem('np.cloud.refresh', refresh as string);
    localStorage.setItem('np.cloud.user', user as string);
    localStorage.setItem('np.cloud.sessionId', sessionId as string);
    sessionStorage.clear();
    const s = currentSession();
    expect(s).not.toBeNull();
    expect(s?.user.email).toBe('a@b.c');
    expect(hasFreshAccess()).toBe(false); // forces the silent refresh path
  });
});

describe('E2E profile vault crypto', () => {
  const userId = 'usr_vault';
  const profileId = 'np-local-p1';

  it('roundtrips a full config through encrypt/decrypt with the derived key', async () => {
    const salt = randomSaltB64();
    const raw = await deriveRawKey('Sup3rSecurePass', salt);
    const key = await importRawKey(raw);
    const config = JSON.stringify({ providerId: 'singbox', name: 'relay-fr', configText: 'vless://uuid-secret@host:443?security=tls#name' });
    const blob = await encryptProfileBlob(key, userId, profileId, config);
    expect(blob.startsWith('v1.')).toBe(true);
    expect(blob).not.toContain('uuid-secret');
    expect(blob).not.toContain('vless://');
    const round = await decryptProfileBlob(key, userId, profileId, blob);
    expect(JSON.parse(round)).toEqual(JSON.parse(config));
  });

  it('binds blobs to account and profile via AAD', async () => {
    const key = await importRawKey(await deriveRawKey('Sup3rSecurePass', randomSaltB64()));
    const blob = await encryptProfileBlob(key, userId, profileId, 'secret-config');
    // another profile id cannot authenticate the blob
    await expect(decryptProfileBlob(key, userId, 'np-local-p2', blob)).rejects.toBeInstanceOf(VaultCryptoError);
    // another account cannot either
    await expect(decryptProfileBlob(key, 'usr_other', profileId, blob)).rejects.toBeInstanceOf(VaultCryptoError);
    // a different password derives a different key: garbage in, VaultCryptoError out
    const otherKey = await importRawKey(await deriveRawKey('AnotherPass123x', randomSaltB64()));
    await expect(decryptProfileBlob(otherKey, userId, profileId, blob)).rejects.toBeInstanceOf(VaultCryptoError);
    // malformed blobs are refused, not crashed on
    await expect(decryptProfileBlob(key, userId, profileId, 'v2.x.y')).rejects.toBeInstanceOf(VaultCryptoError);
  });

  it('the cloud contract accepts only opaque base64 blobs — no plaintext config field exists', () => {
    const ok = VaultPutSchema.safeParse({ profileId: 'np-local-p1', ciphertext: 'v1.AAAAAAAA.AAAAAAAA==', updatedAt: 1 });
    expect(ok.success).toBe(true);
    const plaintext = VaultPutSchema.safeParse({ profileId: 'p', ciphertext: 'vless://uuid@host:443', updatedAt: 1 });
    expect(plaintext.success).toBe(false);
    const tooBig = VaultPutSchema.safeParse({ profileId: 'p', ciphertext: `v1.${'A'.repeat(97_000)}`, updatedAt: 1 });
    expect(tooBig.success).toBe(false);
  });
});
