import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';

import type { FastifyInstance } from 'fastify';

/**
 * Desktop CORS contract — the packaged webview origin.
 *
 * Regression for the "backend unreachable while the backend is healthy" bug:
 * the webview serves the UI from http(s)://tauri.localhost, a DIFFERENT origin
 * from the loopback sidecar. Every API call carries an Authorization header,
 * so each triggers a CORS preflight; if the sidecar's allowlist lacks the
 * webview origin, the browser blocks the response and the UI retries forever
 * (attempt 1095) while curl/node probes all pass — only the webview breaks.
 */

let app: FastifyInstance;
let tmpDir: string;
const token = 'a'.repeat(64);

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-cors-'));
  const built = await buildApp({
    configOverrides: {
      dataDir: tmpDir,
      dbPath: path.join(tmpDir, 'test.db'),
      tokenFile: path.join(tmpDir, 'token'),
      webDist: path.join(tmpDir, 'no-dist'),
      isTest: true,
    },
    daemonToken: token,
  });
  app = built.app;
  await app.ready();
});

afterAll(async () => {
  await app.close();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* WAL handle release can race on Windows; the OS temp dir is cleaned later */
  }
});

const preflight = (origin: string) =>
  app.inject({
    method: 'OPTIONS',
    url: '/api/v1/meta/health',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    },
  });

describe('desktop webview CORS', () => {
  it('allows preflight from the packaged webview origin (tauri.localhost)', async () => {
    for (const origin of ['http://tauri.localhost', 'https://tauri.localhost']) {
      const res = await preflight(origin);
      expect(res.statusCode, origin).toBe(204);
      expect(res.headers['access-control-allow-origin'], origin).toBe(origin);
      expect(String(res.headers['access-control-allow-headers'])).toContain('authorization');
      expect(String(res.headers['access-control-allow-credentials'])).toBe('true');
    }
  });

  it('still allows the dev origins (tauri dev flow)', async () => {
    const res = await preflight('http://localhost:5173');
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('withholds CORS headers from unknown origins (browser blocks the response)', async () => {
    const res = await preflight('https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('desktop auth accepts the bearer token from the webview origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/meta/health',
      headers: { Origin: 'http://tauri.localhost', Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('actual requests carry CORS headers for the webview origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/meta/health',
      headers: { Origin: 'http://tauri.localhost', Authorization: `Bearer ${token}` },
    });
    expect(res.headers['access-control-allow-origin']).toBe('http://tauri.localhost');
  });

  /**
   * Regression for "saving settings fails with Failed to fetch": @fastify/cors
   * defaults to methods GET,HEAD,POST, so a PUT preflight was rejected (404)
   * and the browser never sent the actual request. Every state-changing call
   * from the webview (PUT/PATCH/DELETE) depends on this.
   */
  it('allows PUT/PATCH/DELETE preflights from the webview origin', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const res = await preflightFor(method);
      expect(res.statusCode, method).toBe(204);
      expect(res.headers['access-control-allow-origin'], method).toBe('http://tauri.localhost');
      expect(String(res.headers['access-control-allow-methods']), method).toContain(method);
    }
  });

  it('a real authenticated PUT from the webview origin is accepted', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: { Origin: 'http://tauri.localhost', Authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://tauri.localhost');
  });

  function preflightFor(method: 'PUT' | 'PATCH' | 'DELETE') {
    return app.inject({
      method: 'OPTIONS',
      url: '/api/v1/settings',
      headers: {
        Origin: 'http://tauri.localhost',
        'Access-Control-Request-Method': method,
      },
    });
  }
});
