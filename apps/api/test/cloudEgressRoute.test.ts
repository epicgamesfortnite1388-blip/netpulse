import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import { cloudOrigin } from '../src/services/egressProxy';

import type { FastifyInstance } from 'fastify';

/**
 * The egress route over the wire.
 *
 * Two things it must get right, and both have failed once:
 *
 *  - It resolves the client's *path* against the cloud origin. Building that
 *    URL against a placeholder host made every sign-in fail with
 *    "invalid_egress_path" while the unit tests stayed green.
 *  - It cannot be used to reach anything but the cloud, so the reply to a
 *    smuggled host is a rejection rather than a fetch.
 *
 * No request is made to the real cloud here: these assert routing, validation
 * and the guard. `egressThroughProxy.test.ts` proves the proxied request
 * itself, against a local proxy.
 */
describe('POST /api/v1/cloud/egress', () => {
  let app: FastifyInstance;
  let cookie: string;

  beforeAll(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-egress-'));
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

    const session = await app.inject({ method: 'POST', url: '/api/v1/auth/session', remoteAddress: '127.0.0.1' });
    const c = session.cookies.find((x) => x.name === 'netpulse_session');
    cookie = `${c!.name}=${c!.value}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  function post(body: unknown) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/cloud/egress',
      remoteAddress: '127.0.0.1',
      headers: { cookie },
      payload: body as never,
    });
  }

  it('refuses a caller-supplied host instead of fetching it', async () => {
    // `//evil.test/x` parses as a protocol-relative URL: if the route resolved
    // this against anything but its own origin, this would be a relay.
    const res = await post({ path: '//evil.test/steal', method: 'GET' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_egress_path');
  });

  it('rejects a body that does not name a path', async () => {
    const res = await post({ method: 'GET' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('rejects a path that does not start at the root', async () => {
    const res = await post({ path: 'api/v1/health' });
    expect(res.statusCode).toBe(400);
  });

  it('requires a session, like every other API route', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cloud/egress',
      remoteAddress: '127.0.0.1',
      payload: { path: '/api/v1/health' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('resolves the client path against the cloud origin', async () => {
    // The placeholder-host bug made this route reject every well-formed path
    // with `invalid_egress_path`, so sign-in failed while every proxy test
    // passed. What must never come back is that rejection: either the call
    // reached the cloud, or the sidecar reports a transport failure with a
    // reason. Both are proof the path was resolved against the real origin.
    const res = await post({ path: '/api/v1/health', method: 'GET', timeoutMs: 8000 });

    if (res.statusCode === 502) {
      // Offline / blocked: an egress reason, which is still not our own 400.
      const code = res.json().error.code;
      expect(code).not.toBe('invalid_egress_path');
      expect([
        'proxy_unreachable',
        'direct_unreachable',
        'timeout',
        'tls_failed',
        'socks_unsupported',
      ]).toContain(code);
      return;
    }

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // A real upstream response, passed through verbatim.
    expect(body.status).toBeGreaterThanOrEqual(200);
    expect(typeof body.body).toBe('string');
  });

  it('returns only the upstream status, headers and body', async () => {
    const res = await post({
      path: '/api/v1/health',
      method: 'GET',
      headers: { authorization: 'Bearer test', 'x-forwarded-for': '1.2.3.4', cookie: 'nope' },
      timeoutMs: 8000,
    });
    if (res.statusCode !== 200) {
      expect(res.json().error.code).not.toBe('invalid_egress_path');
      return;
    }
    // Only the upstream fields come back; none of our own headers are echoed.
    expect(Object.keys(res.json()).sort()).toEqual(['body', 'headers', 'status']);
  });
});

describe('cloud origin', () => {
  it('is the one place the cloud host is written', () => {
    expect(cloudOrigin().origin).toBe('https://netpulse-cloud.shuridehradin.workers.dev');
    expect(cloudOrigin().protocol).toBe('https:');
  });
});