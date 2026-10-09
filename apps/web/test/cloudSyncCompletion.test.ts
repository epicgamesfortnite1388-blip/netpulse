import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A successful sync has to leave two marks: the `lastSyncAt` stamp the account
 * page renders, and that stamp being visible in React at all.
 *
 * Playtesting found the second one missing. The session used to live in two
 * places — a module-level cache in sessionStore and a second copy inside the
 * React store — and `syncNow` -> `markSynced` wrote one while the page rendered
 * the other, so clicking "Sync now" on a working connection completed and the
 * page still read "Last sync: not yet" until the app was restarted. Shipping
 * that split meant adding a `refreshSession()` for the sync path to remember to
 * call; collapsing the two stores into one removes the need for either the
 * refresh or the second copy, and these tests are what hold that line.
 */

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn(), post: vi.fn() },
  };
});

const { api } = await import('@/lib/api');
const { lastSyncError, syncNow } = await import('@/lib/cloud/syncEngine');
const { adoptAuthResponse, clearSession, initSession, useSessionStore } = await import('@/lib/cloud/sessionStore');
const { useCloudSession } = await import('@/lib/cloud/useCloudSession');

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

/** Answer the relay the way the sidecar does: the upstream status in the body. */
const relay = (body: unknown) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** A cloud that answers every call the sync makes. */
function cloudIsHealthy(): void {
  vi.mocked(api.post).mockImplementation((async (_path: string, json: { path?: string }) => {
    switch (json?.path) {
      case '/api/v1/settings':
        return relay({ payload: '{}', updatedAt: 0, ok: true, updatedAtMs: 1 });
      case '/api/v1/preferences':
        return relay({ preferences: [] });
      case '/api/v1/profiles':
        return relay({ profiles: [] });
      // Profile backup now runs on the API, but the webview still lists the
      // cloud's vault rows to tombstone ones whose local profile is gone, so
      // the fake cloud has to answer this shape or the pass cannot finish.
      case '/api/v1/profile-vaults':
        return relay({ vaults: [] });
      case '/api/v1/favorites':
        return relay({ favorites: [] });
      default:
        return relay({ ok: true });
    }
  }) as never);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  adoptAuthResponse(auth);
  vi.mocked(api.get).mockImplementation((async (p: string) => {
    if (p === '/settings') return { settings: { general: { notifications: true } } };
    if (p === '/vpn/profiles') return { profiles: [] };
    if (p.startsWith('/nodes')) return { nodes: [], total: 0 };
    return {};
  }) as never);
});

afterEach(() => {
  clearSession();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
});

describe('a completed sync is recorded and shown', () => {
  it('stamps lastSyncAt and clears any previous error', async () => {
    cloudIsHealthy();

    const result = await syncNow();

    expect(result.ok).toBe(true);
    expect(lastSyncError()).toBeNull();
    const stamped = localStorage.getItem('np.cloud.lastSyncAt');
    expect(stamped).not.toBeNull();
    expect(Number(stamped)).toBeGreaterThan(0);
  });

  it('puts that stamp in front of React, not just in localStorage', async () => {
    cloudIsHealthy();
    useCloudSession.getState().init();
    // What the account page sees on mount, before any sync this session.
    expect(useSessionStore.getState().session?.lastSyncAt).toBeNull();

    // React reads this store through useSyncExternalStore, so a subscription is
    // exactly the signal a re-render hangs off: if `markSynced` persisted the
    // stamp without publishing it here, nothing below would ever fire and the
    // page would keep the value it mounted with.
    const seen: (number | null)[] = [];
    const unsubscribe = useSessionStore.subscribe((s) => seen.push(s.session?.lastSyncAt ?? null));

    await syncNow();
    unsubscribe();

    // No refreshSession() call — the single owner publishes the write itself.
    expect(seen).toContainEqual(expect.any(Number));
    expect(useSessionStore.getState().session?.lastSyncAt).toEqual(expect.any(Number));
  });

  it('keeps exactly one owner for the session', () => {
    // Guard on the collapse itself. The bug this pass removes came from the
    // session existing twice, so a second copy creeping back in — with it, the
    // need for a refresh call to copy one into the other — has to fail here
    // rather than in front of a user staring at "Last sync: not yet".
    const reactState = useCloudSession.getState() as Record<string, unknown>;
    expect(reactState).not.toHaveProperty('session');
    expect(reactState).not.toHaveProperty('refreshSession');
  });

  it('signs React out from the one write that clears the session', () => {
    cloudIsHealthy();
    useCloudSession.getState().init();
    expect(useSessionStore.getState().session).not.toBeNull();

    clearSession();

    // `cloudAuth.logout` only calls `clearSession`; if the welcome gate did not
    // follow from this, a signed-out user would still see the dashboard.
    expect(useSessionStore.getState().session).toBeNull();
  });

  it('leaves the previous stamp alone when a later sync fails', async () => {
    cloudIsHealthy();
    await syncNow();
    const good = localStorage.getItem('np.cloud.lastSyncAt');

    vi.mocked(api.post).mockRejectedValue(new ApiErrorLike('timeout', 'The cloud did not answer in time.'));
    const failed = await syncNow();

    expect(failed.ok).toBe(false);
    expect(localStorage.getItem('np.cloud.lastSyncAt')).toBe(good);
  });
});

// Small helper so the failure case reads like the sidecar's own error.
class ApiErrorLike extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}