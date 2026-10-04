import { describe, expect, it } from 'vitest';

import { ApiError, isRetryableError, parseErrorBody } from '../src/lib/api';

/**
 * The client mirrors ONE envelope: `{ error: { code, message, hint } }`, owned
 * on the server by `apps/api/src/util/apiError.ts`.
 *
 * This reader used to also accept a flat shape `{ error: 'not_found', message }`
 * that 39 route sites emitted. Tolerating both hid the split rather than fixing
 * it, and would have let the server add a third shape nobody reads. The flat
 * case is pinned below as *unsupported* so its return is a deliberate fallback
 * to the HTTP status text rather than a silent partial parse.
 */
describe('parseErrorBody', () => {
  it('reads code, message and hint from the envelope', () => {
    expect(
      parseErrorBody({
        error: { code: 'not_found', message: 'Node "node:does-not-exist" not found' },
      }),
    ).toEqual({ code: 'not_found', message: 'Node "node:does-not-exist" not found', hint: undefined });
  });

  it('reads a validation message — the reason, not a JSON issue dump', () => {
    expect(
      parseErrorBody({
        error: {
          code: 'invalid_id',
          message: 'id must be alphanumeric, colon, dot, underscore, or hyphen',
          issues: [{ path: '', message: 'id must be alphanumeric, colon, dot, underscore, or hyphen' }],
        },
      }).message,
    ).toBe('id must be alphanumeric, colon, dot, underscore, or hyphen');
  });

  it('ignores the retired flat shape instead of half-reading it', () => {
    // The server no longer emits this. If it ever did, the UI must degrade to
    // the status text rather than claim a code it invented.
    expect(parseErrorBody({ error: 'not_found', message: 'Node "x" not found' })).toEqual({
      code: undefined,
      message: undefined,
      hint: undefined,
    });
  });

  it('returns nothing for a body that is not the envelope', () => {
    for (const body of ['Bad Gateway', null, undefined, 42, {}]) {
      expect(parseErrorBody(body)).toEqual({ code: undefined, message: undefined, hint: undefined });
    }
  });

  it('treats blank strings as absent so a status fallback still applies', () => {
    expect(parseErrorBody({ error: { code: '', message: '   ' } })).toEqual({
      code: undefined,
      message: undefined,
      hint: undefined,
    });
  });
});

/**
 * A 400 is permanently failed: `/nodes/bad$id` is not a node id no matter how
 * often it is asked for. Showing "Try again" for one taught the user that the
 * button is pressed regardless of what the error says.
 */
describe('isRetryableError', () => {
  it('refuses to retry a 400', () => {
    expect(isRetryableError(new ApiError('invalid_id', 400, 'id must be alphanumeric'))).toBe(false);
  });

  it('refuses to retry a 404', () => {
    expect(isRetryableError(new ApiError('not_found', 404, 'Node "x" not found'))).toBe(false);
  });

  it('refuses to retry other client errors the server already ruled on', () => {
    for (const status of [401, 403, 405, 409, 422]) {
      expect(isRetryableError(new ApiError('x', status, 'no'))).toBe(false);
    }
  });

  it('allows a retry when the server failed', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(isRetryableError(new ApiError('internal_error', status, 'boom'))).toBe(true);
    }
  });

  it('allows a retry when the server is throttling or timed out', () => {
    expect(isRetryableError(new ApiError('rate_limited', 429, 'Too many tests'))).toBe(true);
    expect(isRetryableError(new ApiError('timeout', 408, 'Request timed out'))).toBe(true);
  });

  it('allows a retry for a transport failure, which is not an API response', () => {
    // The sidecar may have respawned; api.get already re-bootstraps once.
    expect(isRetryableError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isRetryableError(new Error('plain'))).toBe(true);
  });
});