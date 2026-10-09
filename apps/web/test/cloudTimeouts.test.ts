import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Who waits decides how long we wait.
 *
 * Measured on the packaged app before this change: a blocked network cost the
 * user 15.2s of unexplained "Working…" before anything was said. The budget is
 * now chosen by the caller — fast for a person watching the form, longer for
 * work nobody is watching, longer still when the user presses again.
 *
 * What must NOT drift: the reason. These assertions are about the deadline the
 * sidecar is asked to enforce; `cloudEgress.test.ts` pins the wording that
 * arrives when it fires.
 */
const post = vi.fn(async () => ({
  status: 200,
  headers: {},
  body: JSON.stringify({
    user: { id: 'u1', email: 'a@b.test' },
    accessToken: 'access',
    refreshToken: 'refresh',
    session: { id: 's1' },
  }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    post,
    get: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
  },
  ApiError: class ApiError extends Error {},
}));

const { cloudAuth, CLOUD_TIMEOUT, withBackgroundBudget } = await import('../src/lib/cloud/client');

/** The deadline the webview asked the sidecar to enforce for the last call. */
function lastTimeout(): number {
  const calls = post.mock.calls;
  return (calls[calls.length - 1]?.[1] as { timeoutMs: number }).timeoutMs;
}

describe('cloud request budgets', () => {
  beforeEach(() => post.mockClear());

  it('gives an interactive request a short budget, so a blocked user is told fast', async () => {
    await cloudAuth.health();
    expect(lastTimeout()).toBe(5_000);
    // The regression this exists to prevent: one constant, 15s, for everyone.
    expect(lastTimeout()).toBeLessThan(15_000);
  });

  it('honours a caller that deliberately waits longer (a retry the user chose)', async () => {
    await cloudAuth.login('a@b.test', 'pw', CLOUD_TIMEOUT.patient);
    expect(lastTimeout()).toBe(10_000);
  });

  it('gives unattended background sync the long window', async () => {
    await withBackgroundBudget(() => cloudAuth.health());
    expect(lastTimeout()).toBe(CLOUD_TIMEOUT.background);
    expect(lastTimeout()).toBe(15_000);
  });

  it('restores the interactive budget afterwards, including when the work throws', async () => {
    await withBackgroundBudget(() => cloudAuth.health());
    await cloudAuth.health();
    expect(lastTimeout()).toBe(5_000);

    await expect(withBackgroundBudget(async () => { throw new Error('sync exploded'); })).rejects.toThrow('sync exploded');
    await cloudAuth.health();
    expect(lastTimeout()).toBe(5_000);
  });

  it('keeps the budgets ordered so a retry is never shorter than the first try', () => {
    expect(CLOUD_TIMEOUT.interactive).toBeLessThan(CLOUD_TIMEOUT.patient);
    expect(CLOUD_TIMEOUT.patient).toBeLessThan(CLOUD_TIMEOUT.background);
    // No single interactive attempt may cost the old 15s again.
    expect(CLOUD_TIMEOUT.patient).toBeLessThan(15_000);
  });
});