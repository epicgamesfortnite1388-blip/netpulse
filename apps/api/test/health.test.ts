import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/routes/context';
import type { IcmpPingOptions, PlatformNetworkController } from '../src/providers/platform/types';
import type { PingResult, TcpProbeResult } from '@netpulse/shared';

class OfflineController implements PlatformNetworkController {
  readonly id = 'offline-fake';
  async icmpPing(_ip: string, _opts: IcmpPingOptions): Promise<PingResult> {
    throw new Error('offline');
  }
  async tcpProbe(): Promise<TcpProbeResult> {
    return { ok: false, ms: null };
  }
  async systemDnsServers(): Promise<string[]> {
    return [];
  }
  async traceroute(): Promise<never> {
    throw new Error('not used');
  }
  async mtuProbe(): Promise<never> {
    throw new Error('not used');
  }
  async detectVpnBinaries(): Promise<Record<string, boolean>> {
    return { wireguard: false, openvpn: false, singbox: false };
  }
}

let app: FastifyInstance;
let ctx: AppContext;
let cookieHeader: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-health-'));
  const built = await buildApp({
    configOverrides: {
      dataDir: tmpDir,
      dbPath: path.join(tmpDir, 'test.db'),
      tokenFile: path.join(tmpDir, 'token'),
      webDist: path.join(tmpDir, 'no-dist'),
      isTest: true,
    },
    controller: new OfflineController(),
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

function get(url: string) {
  return app.inject({ method: 'GET', url, headers: { cookie: cookieHeader } });
}

describe('GET /meta/health', () => {
  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/meta/health' });
    expect(res.statusCode).toBe(401);
  });

  it('reports all component checks with an aggregate status', async () => {
    const res = await get('/api/v1/meta/health');
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      safeMode: boolean;
      checks: { id: string; state: string; detail: string }[];
      version: string;
      tookMs: number;
    };
    expect(body.safeMode).toBe(false);
    expect(body.version).toBeTruthy();
    const ids = body.checks.map((c) => c.id);
    for (const id of ['database', 'filesystem', 'vpn-engines', 'network', 'backend-assets']) {
      expect(ids).toContain(id);
    }
    const db = body.checks.find((c) => c.id === 'database');
    expect(db?.state).toBe('ok');
    // Offline controller: network degraded, no VPN engines → overall degraded
    const net = body.checks.find((c) => c.id === 'network');
    expect(net?.state).toBe('degraded');
    expect(body.status).toBe('degraded');
  });

  it('marks database failed with a recovery action when the handle breaks', async () => {
    // Simulate a broken DB by closing the underlying sqlite handle.
    const origClose = ctx.db.close.bind(ctx.db);
    // @ts-expect-error test-only surgery on the handle type
    ctx.db.db = { get: () => { throw new Error('disk I/O error'); } };
    const res = await get('/api/v1/meta/health');
    const body = res.json() as { checks: { id: string; state: string; action?: { kind: string } }[] };
    const db = body.checks.find((c) => c.id === 'database');
    expect(db?.state).toBe('failed');
    expect(db?.action?.kind).toBe('repair-reset-state');
    origClose(); // restore for afterAll cleanup
  });
});
