import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { sessionOriginRefusal } from '../src/auth';

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/routes/context';
import type { AuthRequestLike } from '../src/auth';
import type { PlatformNetworkController } from '../src/providers/platform/types';

/**
 * Session issuance gate (security finding H1) + session lifetime.
 *
 * The hole: a session cookie could be minted by any caller reaching the
 * loopback port, so a page the user merely visited could POST here and get a
 * cookie valid for every mutating route. Two rules now stand in the way, and
 * both are asserted here against the REAL route, not just the predicate:
 *
 *   1. a browser request must come from an origin this app recognises
 *      (allowlisted, or the same origin as the request's own Host)
 *   2. non-browser callers are unaffected — they run as the user and can read
 *      the daemon token anyway, so pretending an Origin check stops them would
 *      be security theatre
 *
 * The lifetime rule: the default TTL is short enough that a leaked cookie stops
 * being useful the same day.
 */

class IdleController implements PlatformNetworkController {
  readonly id = 'idle';
  async icmpPing(): Promise<never> { throw new Error('network disabled in tests'); }
  async tcpProbe(): Promise<never> { throw new Error('network disabled in tests'); }
  async systemDnsServers(): Promise<string[]> { return []; }
  async traceroute(): Promise<never> { throw new Error('network disabled in tests'); }
  async mtuProbe(): Promise<never> { throw new Error('network disabled in tests'); }
  async detectVpnBinaries(): Promise<Record<string, boolean>> {
    return { wireguard: false, openvpn: false, singbox: false };
  }
}

const req = (over: Partial<AuthRequestLike> = {}): AuthRequestLike => ({
  headers: {},
  cookies: {},
  method: 'POST',
  ip: '127.0.0.1',
  ...over,
});

describe('sessionOriginRefusal (policy)', () => {
  const allowed = ['http://localhost:5173', 'http://tauri.localhost'];

  it('allows an allowlisted origin', () => {
    expect(sessionOriginRefusal(req({ headers: { origin: 'http://localhost:5173' } }), allowed)).toBeNull();
    expect(sessionOriginRefusal(req({ headers: { origin: 'http://tauri.localhost' } }), allowed)).toBeNull();
  });

  it('allows the request’s own origin even when it is not configured', () => {
    // Serving the SPA from the API itself must not lock the UI out.
    expect(sessionOriginRefusal(req({ headers: { origin: 'http://localhost:8787', host: 'localhost:8787' } }), allowed)).toBeNull();
    expect(sessionOriginRefusal(req({ headers: { origin: 'https://127.0.0.1:9443', host: '127.0.0.1:9443' } }), allowed)).toBeNull();
  });

  it('refuses a foreign origin — the H1 attack shape', () => {
    const refusal = sessionOriginRefusal(req({ headers: { origin: 'https://evil.example', host: '127.0.0.1:8787' } }), allowed);
    expect(refusal).toBeTruthy();
  });

  it('refuses a foreign origin even when the port matches', () => {
    expect(sessionOriginRefusal(req({ headers: { origin: 'http://localhost:9999', host: 'localhost:8787' } }), allowed)).toBeTruthy();
  });

  it('refuses an opaque (null) origin — sandboxed frame or file:// page', () => {
    expect(sessionOriginRefusal(req({ headers: { origin: 'null', host: '127.0.0.1:8787' } }), allowed)).toBeTruthy();
  });

  it('refuses a browser request that withheld its origin', () => {
    expect(sessionOriginRefusal(req({ headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' } }), allowed)).toBeTruthy();
    expect(sessionOriginRefusal(req({ headers: { 'sec-fetch-site': 'same-origin' } }), allowed)).toBeTruthy();
  });

  it('refuses a form-shaped POST with no origin (a cross-site <form> can send one)', () => {
    expect(sessionOriginRefusal(req({ headers: { 'content-type': 'application/x-www-form-urlencoded' } }), allowed)).toBeTruthy();
    expect(sessionOriginRefusal(req({ headers: { 'content-type': 'multipart/form-data; boundary=x' } }), allowed)).toBeTruthy();
    expect(sessionOriginRefusal(req({ headers: { 'content-type': 'text/plain;charset=UTF-8' } }), allowed)).toBeTruthy();
  });

  it('leaves a plain non-browser client alone (no origin, no browser markers)', () => {
    expect(sessionOriginRefusal(req(), allowed)).toBeNull();
    expect(sessionOriginRefusal(req({ headers: { 'content-type': 'application/json' } }), allowed)).toBeNull();
    expect(sessionOriginRefusal(req({ headers: { 'user-agent': 'curl/8.0', accept: '*/*' } }), allowed)).toBeNull();
  });
});

describe('POST /api/v1/auth/session (the real route)', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-session-'));
    const built = await buildApp({
      configOverrides: {
        dataDir: tmpDir,
        dbPath: path.join(tmpDir, 'test.db'),
        tokenFile: path.join(tmpDir, 'token'),
        webDist: path.join(tmpDir, 'no-dist'),
        isTest: true,
      },
      controller: new IdleController(),
    });
    app = built.app;
    ctx = built.ctx;
  });

  afterAll(async () => {
    await app.close();
    ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const post = (headers: Record<string, string>, remoteAddress = '127.0.0.1') =>
    app.inject({ method: 'POST', url: '/api/v1/auth/session', headers, remoteAddress });

  it('refuses a foreign-origin browser and sets no cookie', async () => {
    const res = await post({ origin: 'http://evil.example', host: '127.0.0.1:8787' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('origin_not_allowed');
    expect(res.cookies.find((c) => c.name === 'netpulse_session')).toBeUndefined();
  });

  it('refuses a browser request that withheld its origin (fetch metadata only)', async () => {
    const res = await post({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('origin_not_allowed');
  });

  it('refuses a cross-site form POST, whichever layer stops it first', async () => {
    // Fastify rejects an unregistered form content type with 415 before the
    // handler runs; the gate answers 403 when it does run. Either way the
    // request must not walk away with a session — that is the real assertion.
    const res = await post({ 'sec-fetch-site': 'cross-site', 'content-type': 'application/x-www-form-urlencoded' });
    expect([403, 415]).toContain(res.statusCode);
    expect(res.cookies.find((c) => c.name === 'netpulse_session')).toBeUndefined();
  });

  it('issues a session to the app’s own origin', async () => {
    const res = await post({ origin: 'http://localhost:8799', host: 'localhost:8799' });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'netpulse_session');
    expect(cookie?.value).toBeTruthy();
    expect(cookie?.httpOnly).toBe(true);
    expect(String(cookie?.sameSite).toLowerCase()).toBe('strict');
  });

  it('issues a session to the desktop webview origin', async () => {
    const res = await post({ origin: 'http://tauri.localhost', host: '127.0.0.1:8799' });
    expect(res.statusCode).toBe(200);
  });

  it('still refuses a non-loopback caller before it even looks at the origin', async () => {
    const res = await post({ origin: 'http://evil.example' }, '203.0.113.9');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('remote_access_denied');
  });

  it('leaves the plain local client path working (tests, scripts, tooling)', async () => {
    const res = await post({});
    expect(res.statusCode).toBe(200);
    expect(res.cookies.find((c) => c.name === 'netpulse_session')?.value).toBeTruthy();
  });

  it('reports the TTL it actually applied', async () => {
    const res = await post({});
    expect(res.json().expiresInMs).toBe(ctx.config.sessionTtlMs);
    expect(res.json().expiresInMs).toBe(12 * 3600 * 1000);
  });
});

describe('session lifetime default', () => {
  it('defaults to 12 hours, not a week', () => {
    const cfg = loadConfig({}, process.cwd());
    expect(cfg.sessionTtlMs).toBe(12 * 3600 * 1000);
  });

  it('still honours an explicit override', () => {
    const cfg = loadConfig({ SESSION_TTL_HOURS: '48' }, process.cwd());
    expect(cfg.sessionTtlMs).toBe(48 * 3600 * 1000);
  });

  it('rejects an out-of-range override instead of silently clamping it', () => {
    expect(() => loadConfig({ SESSION_TTL_HOURS: '0' }, process.cwd())).toThrow();
    expect(() => loadConfig({ SESSION_TTL_HOURS: '9999' }, process.cwd())).toThrow();
  });
});

describe('CSRF origin policy on cookie-authenticated mutations', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let tmpDir: string;
  let cookieHeader: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-csrf-'));
    const built = await buildApp({
      configOverrides: {
        dataDir: tmpDir,
        dbPath: path.join(tmpDir, 'test.db'),
        tokenFile: path.join(tmpDir, 'token'),
        webDist: path.join(tmpDir, 'no-dist'),
        isTest: true,
      },
      controller: new IdleController(),
    });
    app = built.app;
    ctx = built.ctx;
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/session', remoteAddress: '127.0.0.1' });
    cookieHeader = `netpulse_session=${res.cookies.find((c) => c.name === 'netpulse_session')!.value}`;
  });

  afterAll(async () => {
    await app.close();
    ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * `/nodes/import` doubles as the discriminator: a request that passes auth
   * fails body validation (400), while one the CSRF policy rejects never reaches
   * the handler (403 csrf_rejected).
   */
  const mutate = (headers: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/nodes/import',
      headers: { cookie: cookieHeader, 'content-type': 'application/json', ...headers },
      payload: { configs: [] },
    });

  it('rejects a foreign origin with csrf_rejected', async () => {
    const res = await mutate({ origin: 'https://evil.example', host: '127.0.0.1:8799' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf_rejected');
  });

  it('accepts the request’s own origin even when it is not configured', async () => {
    const res = await mutate({ origin: 'http://localhost:8799', host: 'localhost:8799' });
    expect(res.statusCode).toBe(400); // auth passed; the body was empty on purpose
  });

  it('accepts an allowlisted dev origin', async () => {
    const res = await mutate({ origin: 'http://localhost:5173', host: '127.0.0.1:8799' });
    expect(res.statusCode).toBe(400);
  });

  it('still requires the cookie in the first place', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes/import',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:8799' },
      payload: { configs: [] },
    });
    expect(res.statusCode).toBe(401);
  });
});
