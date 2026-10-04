import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildApp } from '../src/app';
import {
  apiErrorBody,
  replyApiError,
  replyValidationError,
  validationIssue,
  validationMessage,
} from '../src/util/apiError';

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/routes/context';

/**
 * The API's error envelope has one owner: `src/util/apiError.ts`.
 *
 * It used to have two. 39 route sites wrote `{ error: 'not_found', message }`
 * (error a *string*) and 9 wrote `{ error: { code, message } }`, so the desktop
 * client — which read only the nested one — dropped every message from the
 * other 39 and rendered "Not Found / http_404". These pin the single envelope
 * so a future site cannot quietly reintroduce a second.
 */
describe('apiErrorBody', () => {
  it('nests code and message under error', () => {
    expect(apiErrorBody('not_found', 'Node "x" not found')).toEqual({
      error: { code: 'not_found', message: 'Node "x" not found' },
    });
  });

  it('carries hint only when given one', () => {
    expect(apiErrorBody('busy', 'Core is busy', { hint: 'Try again in a few seconds' }).error).toEqual({
      code: 'busy',
      message: 'Core is busy',
      hint: 'Try again in a few seconds',
    });
    expect('hint' in apiErrorBody('busy', 'Core is busy').error).toBe(false);
  });

  it('never emits an empty message, even if a caller passes one', () => {
    // A blank message would reach the UI as an empty red box, which is the
    // same as saying nothing while looking like it said something.
    expect(apiErrorBody('oops', '').error.message).toBe('oops');
  });

  it('omits an empty issues array rather than sending []', () => {
    expect('issues' in apiErrorBody('validation_error', 'bad', { issues: [] }).error).toBe(false);
  });
});

/** Mirrors the route's IdSchema, whose failure message is what a user sees. */
const IdSchema = z
  .string()
  .regex(/^[a-z0-9:._-]+$/i, 'id must be alphanumeric, colon, dot, underscore, or hyphen');

/** The zod bridge: the human reason used to be buried in a JSON dump. */
describe('validation helpers', () => {
  it('makes the first issue the one-line message', () => {
    const parsed = IdSchema.safeParse('bad$id');
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(validationMessage(parsed.error)).toBe(
      'id must be alphanumeric, colon, dot, underscore, or hyphen',
    );
  });

  it('prefixes the field path when the schema has one', () => {
    const parsed = z.object({ type: z.string() }).safeParse({});
    if (parsed.success) throw new Error('expected failure');
    // The path prefix is this repo's logic; the wording after it belongs to
    // zod and should not be pinned here.
    expect(validationMessage(parsed.error)).toMatch(/^type: .+/);
  });

  it('flattens every issue for transport', () => {
    const parsed = IdSchema.safeParse('bad$id');
    if (parsed.success) throw new Error('expected failure');
    expect(validationIssue(parsed.error)).toEqual([
      { path: '', message: 'id must be alphanumeric, colon, dot, underscore, or hyphen' },
    ]);
  });

  it('has a message for a failure with no issues', () => {
    const empty = { issues: [] } as unknown as z.ZodError;
    expect(validationMessage(empty)).toBe('Invalid request');
  });
});

/** The reply helpers, against a stub that records status + body. */
function stubReply() {
  const sent: { status: number; body: unknown } = { status: 0, body: null };
  const reply = {
    status(code: number) {
      sent.status = code;
      return reply;
    },
    send(body: unknown) {
      sent.body = body;
      return reply;
    },
  };
  return { reply: reply as never, sent };
}

describe('replyApiError', () => {
  it('sets the status and sends the envelope', () => {
    const { reply, sent } = stubReply();
    replyApiError(reply, 404, 'not_found', 'Node "x" not found');
    expect(sent.status).toBe(404);
    expect(sent.body).toEqual({ error: { code: 'not_found', message: 'Node "x" not found' } });
  });

  it('sends validation failures as 400 with the reason as the message', () => {
    const { reply, sent } = stubReply();
    const parsed = IdSchema.safeParse('bad$id');
    if (parsed.success) throw new Error('expected failure');
    replyValidationError(reply, 'invalid_id', parsed.error);
    expect(sent.status).toBe(400);
    expect(sent.body).toEqual({
      error: {
        code: 'invalid_id',
        message: 'id must be alphanumeric, colon, dot, underscore, or hyphen',
        issues: [{ path: '', message: 'id must be alphanumeric, colon, dot, underscore, or hyphen' }],
      },
    });
  });
});
/**
 * The envelope is only real if it arrives on the wire with the right status.
 * Migrating a handler to `apiErrorBody` once dropped a `.status(404)` and the
 * unknown-route handler began answering **200 with an error body** — which
 * `api.get` treats as success, so the UI would have rendered the error object
 * as data. Unit tests on the builder cannot see that; only a request can.
 */
describe('unknown routes over the wire', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-env-'));
    app = (
      await buildApp({
        configOverrides: {
          dataDir: tmpDir,
          dbPath: path.join(tmpDir, 'test.db'),
          tokenFile: path.join(tmpDir, 'token'),
          webDist: path.join(tmpDir, 'no-dist'),
          isTest: true,
        },
      })
    ).app;
  });

  afterAll(async () => {
    await app?.close();
  });

  // Every API route is session-authenticated, so establish one first; without
  // it the requests answer 401 and prove nothing about the error envelope.
  async function authed(method: 'GET' | 'POST', url: string) {
    const session = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      remoteAddress: '127.0.0.1',
    });
    const cookie = session.cookies.find((c) => c.name === 'netpulse_session');
    if (!cookie) throw new Error('no session cookie');
    return app.inject({
      method,
      url,
      remoteAddress: '127.0.0.1',
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
  }

  it('answers 404, not 200, with the standard envelope', async () => {
    const res = await authed('GET', '/api/v1/there-is-no-such-route');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: {
        code: 'not_found',
        message: 'No API route for GET /api/v1/there-is-no-such-route',
      },
    });
  });

  it('answers a bad node id as 400 carrying the reason as the message', async () => {
    const res = await authed('GET', '/api/v1/nodes/bad$id');
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('invalid_id');
    // The reason the user reads, not a JSON dump of zod issues.
    expect(body.error.message).toBe(
      'id must be alphanumeric, colon, dot, underscore, or hyphen',
    );
    expect(body.error.message).not.toContain('"origin"');
  });
});
