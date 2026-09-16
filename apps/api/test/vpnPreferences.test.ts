import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import { runAutoConnectIfNeeded } from '../src/services/autoConnect';

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/routes/context';
import type { PlatformNetworkController } from '../src/providers/platform/types';

/** Minimal controller: these endpoints must not touch the network. */
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-vpn-prefs-'));
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

// Headers built per call, not at module scope — beforeAll assigns the cookie.
const H = () => ({ cookie: cookieHeader });

describe('autoSelectServer gate', () => {
  it('on (default): auto:true passes the gate and reports the honest no-candidates state', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/vpn/tunnel/start', headers: H(), payload: { auto: true } });
    expect(res.statusCode).toBe(400);
    // The gate passed — the refusal is about the empty node pool, not the preference.
    expect(res.json().code ?? (res.json() as { error?: { code?: string } }).error?.code).toBe('tunnel_no_candidates');
  });

  it('off: auto:true is refused with tunnel_auto_select_disabled before any selection', async () => {
    ctx.services.settings.update({ vpn: { autoSelectServer: false } });
    try {
      const res = await app.inject({ method: 'POST', url: '/api/v1/vpn/tunnel/start', headers: H(), payload: { auto: true } });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error?: { code?: string } }).error?.code).toBe('tunnel_auto_select_disabled');
    } finally {
      ctx.services.settings.update({ vpn: { autoSelectServer: true } });
    }
  });
});

describe('autoConnect boot helper', () => {
  it('does nothing when the preference is off (no quick-connect run recorded)', async () => {
    ctx.services.settings.update({ vpn: { autoConnect: false } });
    const before = (await app.inject({ method: 'GET', url: '/api/v1/vpn/history', headers: H() })).json() as { history: { quickConnect: { totalRuns: number } } };
    runAutoConnectIfNeeded(app, ctx, 'tok'.padEnd(40, 'x'));
    await new Promise((r) => setTimeout(r, 300));
    const after = (await app.inject({ method: 'GET', url: '/api/v1/vpn/history', headers: H() })).json() as { history: { quickConnect: { totalRuns: number } } };
    expect(after.history.quickConnect.totalRuns).toBe(before.history.quickConnect.totalRuns);
  });

  it('drives the REAL quick-connect path when enabled (run lands in history)', async () => {
    ctx.services.settings.update({ vpn: { autoConnect: true } });
    try {
      // The same token acquisition the dev entry point uses.
      runAutoConnectIfNeeded(app, ctx, fs.readFileSync(ctx.config.tokenFile, 'utf8').trim());
      // The empty-DB quick connect finishes honestly (no memory, nothing discovered).
      await new Promise((r) => setTimeout(r, 6_000));
      const history = (await app.inject({ method: 'GET', url: '/api/v1/vpn/history', headers: H() })).json() as {
        history: { quickConnect: { runs: Array<{ ok: boolean }>; totalRuns: number } };
      };
      expect(history.history.quickConnect.totalRuns).toBeGreaterThanOrEqual(1);
      expect(history.history.quickConnect.runs[0]?.ok).toBe(false); // nothing to connect to — honest
      expect(ctx.services.tunnel.getStatus().state).toBe('idle'); // and it never faked a tunnel
    } finally {
      ctx.services.settings.update({ vpn: { autoConnect: false } });
    }
  });
});

describe('dnsThroughVpn / autoConnect settings contract', () => {
  it('persisted via PUT and read back exactly', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: H(),
      payload: { vpn: { autoConnect: true, dnsThroughVpn: true, autoSelectServer: false } },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: H() });
    const vpn = (get.json() as { settings: { vpn: { autoConnect: boolean; dnsThroughVpn: boolean; autoSelectServer: boolean } } }).settings.vpn;
    expect(vpn.autoConnect).toBe(true);
    expect(vpn.dnsThroughVpn).toBe(true);
    expect(vpn.autoSelectServer).toBe(false);

    // restore defaults so other tests see the standard state
    ctx.services.settings.update({ vpn: { autoConnect: false, dnsThroughVpn: true, autoSelectServer: true } });
  });
});
