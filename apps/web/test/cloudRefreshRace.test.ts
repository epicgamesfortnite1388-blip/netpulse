import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Concurrent cloud calls must share ONE refresh rotation.
 *
 * The Worker's refresh tokens are single-use and rotate on every call; a second
 * use of the old token is treated as theft and revokes the entire session chain
 * (`refresh_reused`). The account screen loads several cloud resources at once
 * (sessions + devices, the backup list, Telegram status), and after a restart
 * every one of them needs a refresh — so a client that refreshes per request
 * races itself and signs the user out on the first screen they open. This test
 * models the Worker's real rotation/reuse semantics at the sidecar boundary and
 * fails if more than one rotation is attempted.
 */
const post = vi.fn();

vi.mock('@/lib/api', () => ({
  api: { post, get: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn() },
  ApiError: class ApiError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      message: string,
      readonly hint?: string,
    ) {
      super(message);
    }
  },
}));

const { cloudApi } = await import('../src/lib/cloud/client');
const { adoptAuthResponse, clearSession, currentSession } = await import('../src/lib/cloud/sessionStore');

interface EgressBody {
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function egress(status: number, body: unknown): { status: number; headers: Record<string, string>; body: string } {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** The Worker's user record, in the shape the client stores. */
const USER = { id: 'usr_test', email: 'a@b.c', createdAt: 1, lastLoginAt: 2 };

let activeRefresh = 'rt_old';
let activeAccess = 'at_old';
let refreshCalls = 0;

function fakeWorker(): void {
  post.mockImplementation(async (_path: string, raw: unknown) => {
    const call = raw as EgressBody;
    if (call.path === '/api/v1/auth/refresh') {
      const presented = (JSON.parse(call.body ?? '{}') as { refreshToken?: string }).refreshToken;
      // A second use of an already-rotated token: the Worker revokes the
      // session chain and answers refresh_reused.
      if (presented !== activeRefresh) {
        return egress(401, { error: { code: 'refresh_reused', message: 'Refresh token reuse detected — session revoked' } });
      }
      refreshCalls += 1;
      activeRefresh = `rt_new_${refreshCalls}`;
      activeAccess = `at_new_${refreshCalls}`;
      return egress(200, {
        accessToken: activeAccess,
        refreshToken: activeRefresh,
        session: { id: 'sess_1' },
      });
    }

    if (call.headers['Authorization'] !== `Bearer ${activeAccess}`) {
      return egress(401, { error: { code: 'unauthorized', message: 'Authentication required' } });
    }
    if (call.path === '/api/v1/account') return egress(200, { user: USER });
    if (call.path === '/api/v1/account/sessions') return egress(200, { sessions: [] });
    return egress(404, { error: { code: 'not_found', message: 'route not mocked' } });
  });
}

/** Persist a session, then simulate a restart: sessionStorage and memory die. */
function restoredSession(): void {
  adoptAuthResponse({
    user: USER,
    accessToken: 'at_old',
    refreshToken: 'rt_old',
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
  });
  const refresh = localStorage.getItem('np.cloud.refresh');
  const user = localStorage.getItem('np.cloud.user');
  const sessionId = localStorage.getItem('np.cloud.sessionId');
  clearSession();
  localStorage.setItem('np.cloud.refresh', refresh as string);
  localStorage.setItem('np.cloud.user', user as string);
  localStorage.setItem('np.cloud.sessionId', sessionId as string);
  sessionStorage.clear();
}

describe('cloud token refresh', () => {
  beforeEach(() => {
    post.mockReset();
    localStorage.clear();
    sessionStorage.clear();
    activeRefresh = 'rt_old';
    activeAccess = 'at_old';
    refreshCalls = 0;
    fakeWorker();
  });

  it('rotates the refresh token once for requests that need it at the same time', async () => {
    restoredSession();

    const [account, sessions] = await Promise.all([cloudApi.account(), cloudApi.sessions()]);

    expect(account.user.id).toBe('usr_test');
    expect(sessions.sessions).toEqual([]);
    expect(refreshCalls).toBe(1);
    // The rotated token is what a later request will present.
    expect(currentSession()?.refreshToken).toBe('rt_new_1');
  });

  it('keeps the session when a refresh is already in flight', async () => {
    restoredSession();

    await Promise.all([cloudApi.account(), cloudApi.sessions(), cloudApi.account()]);

    expect(currentSession()).not.toBeNull();
    expect(refreshCalls).toBe(1);
  });
});
