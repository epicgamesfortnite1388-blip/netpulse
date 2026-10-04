import { describe, expect, it } from 'vitest';

import { parseErrorBody } from '../src/lib/api';

/**
 * The API sends two error shapes and both are live in the source:
 *
 *   flat   — `{ error: 'not_found', message: 'Node "x" not found' }`
 *            (error is a *string* code; most routes)
 *   nested — `{ error: { code, message, hint } }`
 *            (the error-handler plugin and a few routes)
 *
 * The client used to read only the nested shape, so every flat response fell
 * back to `res.statusText` and `http_<status>` — a missing node rendered as
 * "Not Found / http_404" instead of naming the node. These pin both shapes.
 */
describe('parseErrorBody', () => {
  describe('flat shape (error is the code, prose sits beside it)', () => {
    it('reads the message a 404 node lookup already sends', () => {
      const parsed = parseErrorBody({
        error: 'not_found',
        message: 'Node "node:does-not-exist" not found',
      });
      expect(parsed.code).toBe('not_found');
      expect(parsed.message).toBe('Node "node:does-not-exist" not found');
    });

    it('reads a flat hint', () => {
      expect(parseErrorBody({ error: 'busy', message: 'Core busy', hint: 'Wait 5s' }).hint).toBe('Wait 5s');
    });

    it('keeps the code when the body carries no message', () => {
      expect(parseErrorBody({ error: 'not_found' }).code).toBe('not_found');
    });
  });

  describe('nested shape', () => {
    it('reads code, message and hint from the error object', () => {
      const parsed = parseErrorBody({
        error: { code: 'no_feed', message: 'No local release directory is configured' },
      });
      expect(parsed.code).toBe('no_feed');
      expect(parsed.message).toBe('No local release directory is configured');
    });
  });

  describe('unusable bodies', () => {
    it('returns nothing for a non-object body', () => {
      expect(parseErrorBody('Internal Server Error')).toEqual({});
      expect(parseErrorBody(null)).toEqual({});
      expect(parseErrorBody(undefined)).toEqual({});
    });

    it('ignores blank strings so a fallback still reaches the status text', () => {
      expect(parseErrorBody({ error: '', message: '   ' })).toEqual({});
    });

    it('does not leak a zod detail dump into the one-line message', () => {
      // /nodes/:id validation sends `detail` with a multi-line zod report; it is
      // left out so the message stays readable in the error box.
      const parsed = parseErrorBody({
        error: 'invalid_id',
        detail: '[{"code":"invalid_format","message":"id must match"}]',
      });
      expect(parsed.code).toBe('invalid_id');
      expect(parsed.message).toBeUndefined();
    });
  });
});