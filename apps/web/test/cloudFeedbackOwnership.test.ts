import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

/**
 * The sync engine used to build its own ``cloud: ${err.code}`` string and show
 * THAT to the user, while calling classifySyncError only for its `offline`
 * flag and discarding the sentence it had just computed. Playtesting the real
 * app on a filtered network produced "Last attempt: cloud: timeout" on the
 * account page, beside sign-in and the Telegram card both saying "The cloud
 * did not answer in time." — one failure, two vocabularies, and the sync one
 * is a code nobody can act on.
 *
 * These tests drive the REAL runSync: the only seam is the sidecar transport,
 * so the whole chain runs — syncEngine -> cloudApi -> rawFetch -> the mocked
 * loopback hop — and the assertion is on the string the user is shown. They
 * fail against the old catch block, which is the point.
 */

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn(), post: vi.fn() },
  };
});

const { api } = await import('@/lib/api');
const { CloudError } = await import('@/lib/cloud/client');
const { classifySyncError, lastSyncError, syncNow } = await import('@/lib/cloud/syncEngine');
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

/** An egress failure exactly as the sidecar reports one: reason code + sentence. */
const sidecarRefused = (code: string, message: string) =>
  new ApiError(code, 502, message, 'The cloud did not answer in time.');

beforeEach(() => {
  adoptAuthResponse(auth);
  vi.mocked(api.get).mockResolvedValue({ settings: {} } as never);
});

afterEach(() => {
  clearSession();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
});

describe('a failed sync shows the reason, never a code', () => {
  it('shows the sidecar sentence rather than "cloud: timeout"', async () => {
    vi.mocked(api.post).mockRejectedValue(sidecarRefused('timeout', 'The cloud did not answer in time.'));

    const result = await syncNow();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('The cloud did not answer in time.');
    expect(result.error).not.toContain('cloud:');
    // What the Account page renders verbatim, a moment later.
    expect(lastSyncError()).toBe('The cloud did not answer in time.');
  });

  it.each([
    ['proxy_unreachable', 'The proxy at http=127.0.0.1:7890 could not be reached.'],
    ['socks_failed', 'The SOCKS proxy at socks5://127.0.0.1:1080 refused the connection.'],
    ['tls_failed', 'The secure connection to the cloud service could not be established.'],
  ])('passes the %s sentence through untouched', async (code, sentence) => {
    vi.mocked(api.post).mockRejectedValue(sidecarRefused(code, sentence));

    const result = await syncNow();

    expect(result.error).toBe(sentence);
    expect(result.error).not.toContain(code);
  });

  it('shows a Worker sentence for a real server error too', async () => {
    vi.mocked(api.post).mockResolvedValue({
      status: 409,
      headers: {},
      body: JSON.stringify({ error: { code: 'conflict', message: 'Request conflicts with existing data' } }),
    } as never);

    const result = await syncNow();

    expect(result.error).toBe('Request conflicts with existing data');
    expect(result.error).not.toContain('cloud:');
  });

  it('calls a sidecar failure offline, and says so in its own words', async () => {
    // Not an egress reason, so the one-owner boundary in rawFetch applies:
    // the sidecar's sentence is NOT passed through, because that sentence is
    // about the backend on the user's machine, not about their network.
    vi.mocked(api.post).mockRejectedValue(new ApiError('internal_error', 500, 'boom'));

    const result = await syncNow();

    expect(result.offline).toBe(true);
    expect(result.error).toBe('The local backend did not respond, so the cloud request was never sent.');
    expect(result.error).not.toContain('cloud:');
  });
});

describe('classifySyncError stays the single owner of that wording', () => {
  it('returns a sentence for every egress reason, not the reason code', () => {
    const { message } = classifySyncError(new CloudError('timeout', 0, 'The cloud did not answer in time.'));
    expect(message).toBe('The cloud did not answer in time.');
    expect(message).not.toContain('timeout');
  });

  it('does not prefix a local failure with "local:"', () => {
    const { message } = classifySyncError(new ApiError('not_found', 404, 'No node with that id'));
    expect(message).toBe('No node with that id');
  });

  it('keeps a plain Error message rather than inventing a code', () => {
    expect(classifySyncError(new Error('fetch failed'))).toEqual({ offline: true, message: 'fetch failed' });
  });
});