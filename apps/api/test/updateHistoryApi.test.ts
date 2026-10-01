import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import { UpdateFeedHistoryService } from '../src/services/updateFeedHistory';

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/routes/context';
import type { PlatformNetworkController } from '../src/providers/platform/types';
import type { UpdateHistoryEntry } from '@netpulse/shared';

/**
 * Update history — the updater's honest diary.
 *
 * The rules these tests defend:
 *   - every recorded event reads back exactly as stored (versions and reasons
 *     intact, newest first)
 *   - history routes are AUTHENTICATED (unlike the public update-feed file
 *     routes) — another local process cannot read or forge the diary
 *   - malformed events are refused, not silently normalized into lies
 *   - recording failures never break the caller (best-effort by design)
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

let app: FastifyInstance;
let ctx: AppContext;
let cookieHeader: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-updh-'));
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
  const cookie = res.cookies.find((c) => c.name === 'netpulse_session');
  cookieHeader = `netpulse_session=${cookie!.value}`;
});

afterAll(async () => {
  await app.close();
  ctx.db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const H = () => ({ cookie: cookieHeader });

describe('UpdateFeedHistoryService (store seam)', () => {
  it('round-trips events newest-first with versions and reasons intact', () => {
    const svc = new UpdateFeedHistoryService({ events: ctx.repos.nodeEvents, log: { warn: () => {} } });
    svc.record({ kind: 'check', outcome: 'up-to-date', fromVersion: '1.1.0' });
    svc.record({ kind: 'check', outcome: 'available', fromVersion: '1.1.0', toVersion: '1.2.0' });
    svc.record({ kind: 'install', outcome: 'failed', fromVersion: '1.1.0', toVersion: '1.2.0', reason: 'node.exe still locked' });
    const rows = svc.list();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ kind: 'install', outcome: 'failed', reason: 'node.exe still locked', toVersion: '1.2.0' });
    expect(rows[2]).toMatchObject({ kind: 'check', outcome: 'up-to-date', fromVersion: '1.1.0' });
  });

  it('refuses an unknown outcome instead of storing a guess', () => {
    const svc = new UpdateFeedHistoryService({ events: ctx.repos.nodeEvents, log: { warn: () => {} } });
    const before = svc.list().length;
    svc.record({ kind: 'check', outcome: 'sort-of-fine' as never });
    expect(svc.list().length).toBe(before);
  });
});

describe('update-history routes', () => {
  it('GET requires auth (history is the app diary, not a public feed)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/update-history' });
    expect(res.statusCode).toBe(401);
  });

  it('POST requires auth too', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/update-history', payload: { kind: 'check', outcome: 'up-to-date' } });
    expect(res.statusCode).toBe(401);
  });

  it('records via POST and reads back via GET', async () => {
    const post = await app.inject({
      method: 'POST',
      url: '/api/v1/update-history',
      headers: H(),
      payload: { kind: 'check', outcome: 'available', fromVersion: '1.1.0', toVersion: '9.9.9' },
    });
    expect(post.statusCode).toBe(204);

    const get = await app.inject({ method: 'GET', url: '/api/v1/update-history', headers: H() });
    expect(get.statusCode).toBe(200);
    const body = get.json() as { events: UpdateHistoryEntry[] };
    expect(body.events[0]).toMatchObject({ kind: 'check', outcome: 'available', toVersion: '9.9.9' });
    expect(typeof body.events[0].at).toBe('number');
  });

  it('refuses a malformed event with 400, not a normalized lie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/update-history',
      headers: H(),
      payload: { kind: 'check', outcome: 'available-but-actually-broken' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses an oversized reason rather than storing unbounded text', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/update-history',
      headers: H(),
      payload: { kind: 'install', outcome: 'failed', reason: 'x'.repeat(2001) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('DELETE requires auth like every other diary write', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/update-history' });
    expect(res.statusCode).toBe(401);
  });

  it('DELETE clears ONLY update-feed:history rows and reports the true count', async () => {
    const svc = new UpdateFeedHistoryService({ events: ctx.repos.nodeEvents, log: { warn: () => {} } });
    svc.record({ kind: 'check', outcome: 'up-to-date' });
    svc.record({ kind: 'check', outcome: 'failed', reason: 'boom' });
    // A foreign kind in the same event log must survive the clear.
    ctx.repos.nodeEvents.insert({ kind: 'vpn-history:report-run', at: Date.now(), payload: { note: 'keep me' } });

    const del = await app.inject({ method: 'DELETE', url: '/api/v1/update-history', headers: H() });
    expect(del.statusCode).toBe(200);
    const body = del.json() as { ok: boolean; removed: number };
    expect(body.ok).toBe(true);
    expect(body.removed).toBeGreaterThanOrEqual(2);

    const get = await app.inject({ method: 'GET', url: '/api/v1/update-history', headers: H() });
    expect((get.json() as { events: UpdateHistoryEntry[] }).events).toHaveLength(0);
    // The foreign kind's rows are untouched.
    expect(ctx.repos.nodeEvents.recent('vpn-history:report-run', 10).length).toBeGreaterThanOrEqual(1);
  });

  it('DELETE on an empty diary reports removed: 0', async () => {
    const del = await app.inject({ method: 'DELETE', url: '/api/v1/update-history', headers: H() });
    expect(del.statusCode).toBe(200);
    expect((del.json() as { removed: number }).removed).toBe(0);
  });
});
