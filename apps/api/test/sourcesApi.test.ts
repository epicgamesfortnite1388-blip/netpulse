import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';

/**
 * Integration tests for the node-sources management endpoints added in the
 * feature audit: PATCH /sources/:id (enable/disable) and DELETE /sources/:id,
 * plus the pre-existing create + list round trip.
 */
describe('node sources management', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
  let cookieHeader: string;
  let tmpDir: string;

  const inject = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
    url: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers:
        payload !== undefined
          ? { cookie: cookieHeader, 'content-type': 'application/json' }
          : { cookie: cookieHeader },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-sources-'));
    const built = await buildApp({
      configOverrides: {
        dataDir: tmpDir,
        dbPath: path.join(tmpDir, 'test.db'),
        tokenFile: path.join(tmpDir, 'token'),
        webDist: path.join(tmpDir, 'no-dist'),
        isTest: true,
      },
    });
    app = built.app;
    ctx = built.ctx;
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/session', remoteAddress: '127.0.0.1' });
    const cookie = res.cookies.find((c) => c.name === 'netpulse_session');
    expect(cookie).toBeDefined();
    cookieHeader = `netpulse_session=${cookie!.value}`;
  });

  afterAll(async () => {
    await app.close();
    ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates, toggles and deletes a custom source', async () => {
    const name = `audit-${crypto.randomUUID().slice(0, 8)}`;
    const created = await inject('POST', '/api/v1/sources', {
      name,
      urls: ['https://example.com/subs/list.txt'],
    });
    expect(created.statusCode).toBe(201);
    const source = created.json();
    expect(source.id).toBeTruthy();

    // Disable
    const off = await inject('PATCH', `/api/v1/sources/${source.id}`, { enabled: false });
    expect(off.statusCode).toBe(200);
    expect(off.json().enabled).toBe(false);
    expect(ctx.repos.publicSources.get(source.id)?.enabled).toBe(false);

    // Re-enable
    const on = await inject('PATCH', `/api/v1/sources/${source.id}`, { enabled: true });
    expect(on.json().enabled).toBe(true);

    // Delete
    const del = await inject('DELETE', `/api/v1/sources/${source.id}`);
    expect(del.statusCode).toBe(200);
    expect(ctx.repos.publicSources.get(source.id)).toBeUndefined();
  });

  it('rejects private/loopback source URLs (SSRF guard)', async () => {
    const res = await inject('POST', '/api/v1/sources', {
      name: 'ssrf',
      urls: ['http://127.0.0.1:8080/admin'],
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s for unknown source ids', async () => {
    expect((await inject('PATCH', '/api/v1/sources/nope', { enabled: false })).statusCode).toBe(404);
    expect((await inject('DELETE', '/api/v1/sources/nope')).statusCode).toBe(404);
  });

  it('lists sources including built-in catalog entries', async () => {
    const res = await inject('GET', '/api/v1/sources');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.sources)).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(0);
  });

  it('seeds built-in sources into the DB at boot so fetch/disable resolve them', async () => {
    // Regression: built-ins lived only in constants — the list served them
    // from memory while fetch looked them up in the DB, so every built-in
    // Fetch 502'd with "source not found: barry-far".
    const seeded = ctx.repos.publicSources.get('barry-far');
    expect(seeded).toBeDefined();
    expect(seeded!.enabled).toBe(true);
    expect(seeded!.urls.length).toBeGreaterThan(0);
    expect(seeded!.urls.every((u: string) => u.startsWith('https://'))).toBe(true);

    // The list route now reflects the DB (same ids, DB-first ordering).
    const list = await inject('GET', '/api/v1/sources');
    const ids = list.json().sources.map((s: { id: string }) => s.id);
    expect(ids).toContain('barry-far');

    // Disable a built-in through the API — previously 404 for built-ins.
    const off = await inject('PATCH', '/api/v1/sources/barry-far', { enabled: false });
    expect(off.statusCode).toBe(200);
    expect(ctx.repos.publicSources.get('barry-far')?.enabled).toBe(false);
    const on = await inject('PATCH', '/api/v1/sources/barry-far', { enabled: true });
    expect(on.json().enabled).toBe(true);
  });

  it('seeding is idempotent and preserves user state across rebuilds', async () => {
    // Simulate a restart: flip state, re-run the seeder, state must survive.
    ctx.repos.publicSources.update('barry-far', { enabled: false });
    const { seedKnownSources } = await import('../src/services/nodeSourceRegistry');
    seedKnownSources(ctx.repos.publicSources);
    expect(ctx.repos.publicSources.get('barry-far')?.enabled).toBe(false);
    // restore
    ctx.repos.publicSources.update('barry-far', { enabled: true });
  });
});
