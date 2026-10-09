import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Who writes the sentence a user reads about a failed cloud call.
 *
 * There is exactly one writer: the sidecar (apps/api/src/services/egressProxy.ts),
 * which classifies the transport failure and sends the sentence with it. The
 * webview used to keep a second copy of those sentences and override the
 * sidecar's — and the two had already drifted into advice that was actively
 * wrong, reporting a SOCKS listener that asked for a password as a broken proxy
 * the user should restart.
 *
 * These tests therefore assert a contract, not a sentence: whatever the
 * sidecar says is what the user gets.
 */
const post = vi.fn();

vi.mock('@/lib/api', () => ({
  api: { post, get: vi.fn(), put: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      readonly message: string,
      readonly hint?: string,
    ) {
      super(message);
    }
  },
}));

const { cloudAuth } = await import('../src/lib/cloud/client');

/** Drive one call with the sidecar rejecting the way it does for egress. */
async function failWith(code: string, message: string, hint?: string): Promise<string> {
  const { ApiError } = (await import('@/lib/api')) as unknown as {
    ApiError: new (code: string, status: number, message: string, hint?: string) => Error;
  };
  post.mockRejectedValueOnce(new ApiError(code, code === 'validation_error' ? 400 : 502, message, hint));
  try {
    // `login` propagates a delivery failure; `health` deliberately swallows it.
    await cloudAuth.login('audit@example.test', 'Audit-Probe-Passw0rd');
    throw new Error('expected the call to fail');
  } catch (e) {
    return (e as { message: string }).message;
  }
}

describe('cloud failure wording', () => {
  beforeEach(() => post.mockReset());

  it('shows the sidecar sentence verbatim, so the advice cannot drift from the cause', async () => {
    const message = 'The SOCKS proxy at socks5://127.0.0.1:10808 could not carry the connection: it requires a password.';
    expect(await failWith('socks_failed', message, 'proxy: socks5://127.0.0.1:10808')).toBe(message);
  });

  it('never reports a password-protected listener as a proxy to restart', async () => {
    // THE REGRESSION THIS FILE EXISTS FOR: the old copy collapsed every
    // socks_failed into "restart your proxy client", which sends the user to
    // restart a client that is already running and working.
    const message = await failWith(
      'socks_failed',
      'The SOCKS proxy at socks5://127.0.0.1:10808 could not carry the connection: it requires a password, and the Windows system-proxy setting cannot carry one. Turn off SOCKS authentication in your proxy client, or use an HTTP proxy or TUN mode.',
    );
    expect(message).toMatch(/password/i);
    expect(message).not.toMatch(/restart your proxy client/i);
  });

  it('keeps naming the proxy for the other reasons it already named', async () => {
    expect(await failWith('proxy_unreachable', 'Could not reach the system proxy at http://127.0.0.1:7890. Start the tunnel and try again.'))
      .toContain('127.0.0.1:7890');
    expect(await failWith('timeout', 'The cloud did not answer through the proxy (http://127.0.0.1:7890) in time.'))
      .toContain('127.0.0.1:7890');
  });

  it('still says the local backend failed when the sidecar never answered', async () => {
    post.mockRejectedValueOnce(new Error('Failed to fetch'));
    const message = await cloudAuth.login('audit@example.test', 'Audit-Probe-Passw0rd').then(
      () => 'resolved',
      (e: unknown) => (e as { message: string }).message,
    );
    // The one message the webview owns: the sidecar is on loopback, so a
    // failure here is never the network blocking the cloud.
    expect(message).toMatch(/local backend/i);
    expect(message).not.toMatch(/check your connection/i);
  });

  it('does NOT show a relay 500 internal message to the user', async () => {
    // THE REGRESSION: restoring the words without the classification let a
    // backend fault reach the sign-in form as `SQLITE_CONSTRAINT: UNIQUE
    // failed: users.email`. The sidecar still owns the wording for transport
    // failures; a 500 is not one, so it gets the local-backend sentence.
    const internal = 'SQLITE_CONSTRAINT: UNIQUE failed: users.email';
    const message = await failWith('internal_error', internal, 'Check the API logs for request 7f2');
    expect(message).not.toContain('SQLITE');
    expect(message).toMatch(/local backend/i);
    expect(message).not.toMatch(/check your connection/i);
  });

  it('keeps the authenticated-SOCKS sentence exactly as the sidecar words it', async () => {
    // The boundary must not cost the fix from the previous pass.
    const socks = await failWith(
      'socks_failed',
      'The SOCKS proxy at socks5://127.0.0.1:57990 could not carry the connection: it requires a password, and the Windows system-proxy setting cannot carry one. Turn off SOCKS authentication in your proxy client, or use an HTTP proxy or TUN mode.',
      'proxy: socks5://127.0.0.1:57990',
    );
    expect(socks).toMatch(/requires a password/i);
    expect(socks).toMatch(/Turn off SOCKS authentication/i);
    expect(socks).not.toMatch(/local backend/i);
  });

  it('does not leak a validation error from the relay either', async () => {
    const message = await failWith('validation_error', 'path: Required');
    expect(message).toMatch(/local backend/i);
  });

  it('never falls back to the misleading "check your connection"', async () => {
    const reasons: Array<[string, string]> = [
      ['proxy_unreachable', 'Could not reach the system proxy at http://127.0.0.1:7890. Start the tunnel and try again.'],
      ['direct_unreachable', 'Could not reach the cloud — it is blocked or offline on this network.'],
      ['timeout', 'The cloud did not answer in time.'],
      ['tls_failed', 'The TLS connection was rejected — this often means the connection is being filtered.'],
      ['socks_failed', 'The SOCKS proxy at socks5://127.0.0.1:10808 could not carry the connection: it refused the tunnel (SOCKS5 reply 0x05).'],
      ['socks_unsupported', 'The system proxy is a SOCKS4 listener, which this app cannot speak.'],
    ];
    for (const [code, message] of reasons) {
      expect(await failWith(code, message), code).not.toMatch(/check your connection/i);
    }
  });
});