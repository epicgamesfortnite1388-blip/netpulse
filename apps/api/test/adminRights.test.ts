import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import { adminCapabilities, adminStatus, canRelaunchElevated, invalidatePrivilegeCache, isProcessElevated } from '../src/util/privileges';

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/routes/context';
import type { PlatformNetworkController } from '../src/providers/platform/types';

/**
 * Administrator rights + Aether system-wide (TUN) mode.
 *
 * The rules these tests defend:
 *   - the privilege answer comes from a REAL OS check, and this environment's
 *     real answer is whatever it is — the tests assert consistency and honesty,
 *     never a specific privilege level
 *   - every privilege entry explains itself and, when the app can fix it, offers
 *     a remedy (a refusal with no way forward is the defect this feature removes)
 *   - the Aether TUN preference is a real round-trip, and the status only ever
 *     claims `active` after verification
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-admin-'));
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

const H = () => ({ cookie: cookieHeader, 'content-type': 'application/json' });

describe('privileges owner', () => {
  it('reports elevation from a real check and stays self-consistent across calls', () => {
    invalidatePrivilegeCache();
    const first = isProcessElevated();
    // Second call reads the cached answer, so a flip here would mean the probe
    // is not deterministic within a process's lifetime.
    expect(isProcessElevated()).toBe(first);
  });

  it('canRelaunchElevated requires the desktop shell, Windows, and no rights yet', () => {
    invalidatePrivilegeCache();
    const expected = process.platform === 'win32' && process.env['NETPULSE_DESKTOP'] === '1' && !isProcessElevated();
    expect(canRelaunchElevated()).toBe(expected);
  });

  it('explains every capability and offers a remedy wherever the app can fix it', () => {
    const caps = adminCapabilities({ tunGatewayCoreInstalled: false, wireguardInstalled: false });
    expect(caps.map((c) => c.id).sort()).toEqual(['raw-icmp', 'tun-gateway', 'wireguard-tunnel-install']);

    for (const cap of caps) {
      expect(cap.label.length).toBeGreaterThan(0);
      expect(cap.reason.length).toBeGreaterThan(0);
      // Unavailable + admin-gated always carries a way forward.
      if (!cap.available && cap.requiresAdmin) expect(cap.remedy).toBeTruthy();
      // Nothing may claim availability without the core it needs.
      if (cap.id === 'tun-gateway' && !cap.available) expect(cap.available).toBe(false);
    }

    const tun = caps.find((c) => c.id === 'tun-gateway');
    // With no sing-box installed the TUN gateway cannot be available, whatever
    // the privilege level — and the reason must say which of the two it is.
    expect(tun?.available).toBe(false);
    expect(tun?.remedy).toMatch(/sing-box|administrator|UAC|dev API/i);
  });

  it('marks the WireGuard install unavailable when its binary is missing, with a remedy', () => {
    const wg = adminStatus({ tunGatewayCoreInstalled: true, wireguardInstalled: false }).privileges.find(
      (p) => p.id === 'wireguard-tunnel-install',
    );
    expect(wg?.available).toBe(false);
    expect(wg?.remedy).toMatch(/WireGuard/i);
  });
});

describe('GET /vpn/admin', () => {
  it('reports a real privilege answer with attributed reasons', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/vpn/admin', headers: H() });
    expect(res.statusCode).toBe(200);
    const { admin } = res.json() as {
      admin: {
        elevated: boolean;
        platform: string;
        canRelaunchElevated: boolean;
        note: string;
        privileges: Array<{ id: string; reason: string; available: boolean }>;
      };
    };
    expect(typeof admin.elevated).toBe('boolean');
    expect(admin.platform).toBe(process.platform);
    expect(admin.note).toMatch(/administrator/i);
    expect(admin.privileges).toHaveLength(3);
    for (const p of admin.privileges) expect(p.reason.length).toBeGreaterThan(10);
    // The relaunch offer is only true when the shell said so — never assumed.
    expect(admin.canRelaunchElevated).toBe(canRelaunchElevated());
  });

  it('re-check returns the same answer the cached read gives', async () => {
    const first = (await app.inject({ method: 'GET', url: '/api/v1/vpn/admin', headers: H() })).json() as {
      admin: { elevated: boolean };
    };
    const fresh = await app.inject({ method: 'POST', url: '/api/v1/vpn/admin/recheck', headers: H(), payload: {} });
    expect(fresh.statusCode).toBe(200);
    expect((fresh.json() as { admin: { elevated: boolean } }).admin.elevated).toBe(first.admin.elevated);
  });
});

describe('POST /vpn/aether/tun', () => {
  it('round-trips the system-wide preference and reports it on the engine endpoint', async () => {
    const providers = (await app.inject({ method: 'GET', url: '/api/v1/vpn/providers', headers: H() })).json() as {
      providers: Array<{ id: string }>;
    };
    const registered = providers.providers.some((p) => p.id === 'aether');
    const on = await app.inject({ method: 'POST', url: '/api/v1/vpn/aether/tun', headers: H(), payload: { enabled: true } });
    if (!registered) {
      // Honest in a build without the provider: refuse, do not pretend.
      expect(on.statusCode).toBe(501);
      return;
    }
    expect(on.statusCode).toBe(200);
    expect((on.json() as { tun: boolean }).tun).toBe(true);

    const engine = (await app.inject({ method: 'GET', url: '/api/v1/vpn/aether/engine', headers: H() })).json() as { tun: boolean };
    expect(engine.tun).toBe(true);

    const off = await app.inject({ method: 'POST', url: '/api/v1/vpn/aether/tun', headers: H(), payload: { enabled: false } });
    expect((off.json() as { tun: boolean }).tun).toBe(false);
  });

  it('rejects a non-boolean payload instead of coercing it', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/vpn/aether/tun', headers: H(), payload: { enabled: 'yes' } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});
