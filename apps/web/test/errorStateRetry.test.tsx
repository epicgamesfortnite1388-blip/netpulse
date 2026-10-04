import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ErrorState } from '../src/components/ui/States';
import { ApiError } from '../src/lib/api';

/**
 * The retry button is the app's only "try that again" affordance, and it used
 * to render for every error. `/nodes/bad$id` answered 400 with a message saying
 * what was wrong with the id, and the app still offered "Try again" — a button
 * that re-issues the same impossible request forever.
 *
 * `isRetryableError` is unit-tested elsewhere; this renders the real component
 * so the rule is pinned where the user meets it. Server-rendering needs no DOM
 * and no new dependency.
 */

function render(error: unknown, retry?: () => void): string {
  return renderToStaticMarkup(<ErrorState error={error} retry={retry} />);
}

const RETRY = () => {};

describe('ErrorState retry affordance', () => {
  it('offers no retry for a 400, and shows the reason the server gave', () => {
    const html = render(
      new ApiError('invalid_id', 400, 'id must be alphanumeric, colon, dot, underscore, or hyphen'),
      RETRY,
    );
    expect(html).not.toContain('Try again');
    expect(html).toContain('id must be alphanumeric, colon, dot, underscore, or hyphen');
    expect(html).toContain('invalid_id');
  });

  it('offers no retry for a 404', () => {
    const html = render(new ApiError('not_found', 404, 'Node "x" not found'), RETRY);
    expect(html).not.toContain('Try again');
    expect(html).toContain('Node &quot;x&quot; not found');
  });

  it('still offers a retry when the server failed', () => {
    const html = render(new ApiError('internal_error', 500, 'An unexpected error occurred'), RETRY);
    expect(html).toContain('Try again');
  });

  it('offers no button when the caller passed no retry', () => {
    expect(render(new ApiError('internal_error', 500, 'boom'))).not.toContain('Try again');
  });

  it('keeps the generic wording for a non-API failure, and its retry', () => {
    const html = render(new TypeError('Failed to fetch'), RETRY);
    expect(html).toContain('Something went wrong');
    expect(html).toContain('Try again');
  });
});