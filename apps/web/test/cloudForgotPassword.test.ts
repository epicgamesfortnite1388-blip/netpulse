import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sign-in screen's "Forgot password?" path.
 *
 * Two properties matter and neither is visible from the UI: the call must go
 * out WITHOUT a session (the whole point is a user who cannot sign in), and it
 * must travel the same sidecar egress route as every other cloud call so a
 * filtered network gets the proxy diagnosis instead of a silent failure.
 */
const post = vi.fn();

vi.mock('@/lib/api', () => ({
  api: { post, get: vi.fn(), put: vi.fn(), del: vi.fn() },
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

const { cloudAuth } = await import('../src/lib/cloud/client');

interface EgressBody {
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

/** The sidecar's answer for an accepted request. */
function accepted(): { status: number; headers: Record<string, string>; body: string } {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: true, message: 'If the account exists, a reset has been issued' }),
  };
}

function queuedBody(): EgressBody {
  const call = post.mock.calls[0] as [string, EgressBody] | undefined;
  if (!call) throw new Error('the sidecar was never called');
  return call[1];
}

describe('cloudAuth.forgotPassword', () => {
  beforeEach(() => {
    post.mockReset();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('asks the Worker for a reset link without sending any token', async () => {
    post.mockResolvedValueOnce(accepted());
    await cloudAuth.forgotPassword('user@example.test');

    expect(post).toHaveBeenCalledTimes(1);
    expect((post.mock.calls[0] as [string])[0]).toBe('/cloud/egress');
    const sent = queuedBody();
    expect(sent.path).toBe('/api/v1/auth/forgot-password');
    expect(sent.method).toBe('POST');
    // A signed-out user has no access token, and the endpoint is public.
    expect(sent.headers.Authorization).toBeUndefined();
    expect(JSON.parse(sent.body ?? '{}')).toEqual({ email: 'user@example.test' });
  });

  it('surfaces a rate-limit answer instead of pretending the mail went out', async () => {
    post.mockResolvedValueOnce({
      status: 429,
      headers: {},
      body: JSON.stringify({
        error: { code: 'rate_limited', message: 'Too many reset requests — try later' },
        retryAfterSec: 1730,
      }),
    });

    await expect(cloudAuth.forgotPassword('user@example.test')).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
      message: 'Too many reset requests — try later',
      // The screen counts down from here; losing this number would silently
      // turn the countdown back into a bare "try later".
      retryAfterSec: 1730,
    });
  });

  it('keeps the sidecar wording when the cloud cannot be reached', async () => {
    const { ApiError } = (await import('@/lib/api')) as unknown as {
      ApiError: new (code: string, status: number, message: string) => Error;
    };
    const message = 'Could not reach the cloud — it is blocked or offline on this network.';
    post.mockRejectedValueOnce(new ApiError('direct_unreachable', 502, message));

    await expect(cloudAuth.forgotPassword('user@example.test')).rejects.toMatchObject({
      code: 'direct_unreachable',
      status: 0,
      message,
    });
  });
});
