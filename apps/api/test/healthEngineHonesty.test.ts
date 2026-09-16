import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/routes/context';
import type { IcmpPingOptions, PlatformNetworkController } from '../src/providers/platform/types';
import type { PingResult, TcpProbeResult } from '@netpulse/shared';

/**
 * Engine-reporting honesty.
 *
 * The app runs two kinds of engine: system tunnel providers (WireGuard /
 * OpenVPN / sing-box on PATH) and its own app-managed proxy cores (xray /
 * sing-box / v2ray in the data dir) that node tests and the proxy tunnel run.
 *
 * Regression: the self-check reported only the PATH side, so an installation
 * with xray, sing-box and v2ray present rendered "VPN engines: Detected:
 * wireguard" while the engine strip listed three cores — the health surface
 * disagreed with the app's own engine list about what was installed.
 */

/** Reports NO system binaries — the cores are the only engines on this box. */
class NoSystemBinaryController implements PlatformNetworkController {
  readonly id = 'no-binaries-fake';
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

const coreFile = (base: string) =>
  path.join(coreBase, process.platform === 'win32' ? `${base}.exe` : base);

let app: FastifyInstance;
let ctx: AppContext;
let cookieHeader: string;
let tmpDir: string;
let coreBase: string;
const envKeys = ['NETPULSE_CORES_DIR', 'NETPULSE_DATA_DIR'] as const;
const savedEnv: Record<string, string | undefined> = {};

async function buildWith(dataDir: string) {
  const built = await buildApp({
    configOverrides: {
      dataDir,
      dbPath: path.join(dataDir, 'test.db'),
      tokenFile: path.join(dataDir, 'token'),
      webDist: path.join(dataDir, 'no-dist'),
      isTest: true,
    },
    controller: new NoSystemBinaryController(),
  });
  const res = await built.app.inject({
    method: 'POST',
    url: '/api/v1/auth/session',
    remoteAddress: '127.0.0.1',
  });
  const cookie = res.cookies.find((c) => c.name === 'netpulse_session');
  return { ...built, cookieHeader: `netpulse_session=${cookie!.value}` };
}

beforeAll(async () => {
  for (const k of envKeys) savedEnv[k] = process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-engines-'));
  coreBase = path.join(tmpDir, 'cores');
  fs.mkdirSync(coreBase, { recursive: true });
  // A real file where the app looks for its cores. Nothing here executes it.
  fs.writeFileSync(coreFile('xray'), 'placeholder');
  process.env['NETPULSE_CORES_DIR'] = coreBase;
  delete process.env['NETPULSE_DATA_DIR'];

  const built = await buildWith(tmpDir);
  app = built.app;
  ctx = built.ctx;
  cookieHeader = built.cookieHeader;
});

afterAll(async () => {
  await app.close();
  ctx.db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('engine reporting honesty', () => {
  it('names the app-managed proxy cores in the health check', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/meta/health', headers: { cookie: cookieHeader } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; checks: { id: string; state: string; detail: string }[] };
    const vpn = body.checks.find((c) => c.id === 'vpn-engines');
    expect(vpn).toBeDefined();
    // The installed core must be visible...
    expect(vpn!.detail).toContain('Proxy cores: xray');
    // ...and its absence on PATH must not be reported as "no engines".
    expect(vpn!.state).toBe('ok');
    expect(vpn!.detail).toContain('No system VPN provider');
  });

  it('exposes the proxy cores as their own capability, not as "unavailable"', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/meta/capabilities', headers: { cookie: cookieHeader } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      vpn: Record<string, { installed: boolean; note: string }>;
    };
    const cores = body.vpn['proxyCores'];
    expect(cores?.installed).toBe(true);
    expect(cores?.note).toContain('xray');
    // sing-box is honestly not on PATH here — but the note must not claim the
    // whole protocol family cannot work, because the managed cores can run it.
    const singBox = body.vpn['singBox'];
    expect(singBox?.installed).toBe(false);
    expect(singBox?.note).not.toContain('cannot connect');
    expect(singBox?.note).toContain('app-managed cores');
  });

  it('still reports no engines when neither providers nor cores exist', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-nocores-'));
    delete process.env['NETPULSE_CORES_DIR'];
    process.env['NETPULSE_DATA_DIR'] = path.join(bare, 'nothing-here');
    const built = await buildWith(bare);
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/v1/meta/health',
        headers: { cookie: built.cookieHeader },
      });
      const body = res.json() as { checks: { id: string; state: string; detail: string }[] };
      const vpn = body.checks.find((c) => c.id === 'vpn-engines');
      expect(vpn!.state).toBe('degraded');
      expect(vpn!.detail).toContain('No app-managed proxy core');
      expect(vpn!.detail).not.toContain('Proxy cores:');
    } finally {
      await built.app.close();
      built.ctx.db.close();
      fs.rmSync(bare, { recursive: true, force: true });
      process.env['NETPULSE_CORES_DIR'] = coreBase;
      delete process.env['NETPULSE_DATA_DIR'];
    }
  });
});
