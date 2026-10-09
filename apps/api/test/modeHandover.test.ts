import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/routes/context';
import type { PlatformNetworkController } from '../src/providers/platform/types';
import type { VpnProvider, VpnStatus } from '../src/vpn/vpnService';

/**
 * Mode handover — one writer for the machine's network state.
 *
 * The engine VPNs and the proxy tunnel both write the system proxy, arm the
 * same kill-switch hold and claim the default route. These tests pin the rule
 * that keeps those writes from overwriting each other:
 *
 *   - starting the proxy tunnel disconnects a connected engine FIRST (and
 *     acknowledges the drop watchdog, so it cannot reconnect the engine
 *     mid-switch);
 *   - connecting an engine profile stops a non-idle proxy tunnel FIRST;
 *   - a deliberate disconnect stops BOTH modes and clears the watchdog, so a
 *     user disconnect is never resurrected as a "drop".
 *
 * The tunnel's own start fails fast on preflight here (the fixture is a
 * wireguard node, which no local proxy core dials) — deliberately: the test
 * proves the handover ordering without spawning anything, and the failure is
 * an honest `down`, never a fake tunnel.
 */

class IdleController implements PlatformNetworkController {
  readonly id = 'idle';
  async icmpPing(): Promise<never> {
    throw new Error('network disabled in tests');
  }
  async tcpProbe(): Promise<never> {
    throw new Error('network disabled in tests');
  }
  async systemDnsServers(): Promise<string[]> {
    return [];
  }
  async traceroute(): Promise<never> {
    throw new Error('network disabled in tests');
  }
  async mtuProbe(): Promise<never> {
    throw new Error('network disabled in tests');
  }
  async detectVpnBinaries(): Promise<Record<string, boolean>> {
    return { wireguard: false, openvpn: false, singbox: false };
  }
}

const SECRET_UUID = '7c4d2b90-5e31-4f68-9b0a-2d8e6f1c3a57';
const NODE_LINK = `vless://${SECRET_UUID}@handover.example.test:8443?type=tcp&security=tls&sni=handover.example.test#Handover%20fixture`;

/** What the test double observed: connect/disconnect calls and liveness. */
const engine = { connected: false, connects: 0, disconnects: 0 };

function fakeEngineProvider(): VpnProvider {
  const status = (connected: boolean): VpnStatus => ({
    connected,
    serverId: connected ? 'p-handover' : null,
    serverName: connected ? 'Handover fixture' : null,
    protocol: 'wireguard',
    since: connected ? Date.now() : null,
    supported: true,
    killSwitchActive: false,
    providerId: 'wireguard',
  });
  return {
    info: { id: 'wireguard', name: 'WireGuard (test double)', kind: 'wireguard', capabilities: ['connect'], available: true },
    async init() {},
    async importProfile(): Promise<never> {
      throw new Error('unused');
    },
    async connect() {
      engine.connects += 1;
      engine.connected = true;
      return status(true);
    },
    async disconnect() {
      engine.disconnects += 1;
      engine.connected = false;
      return status(false);
    },
    async status() {
      return status(engine.connected);
    },
  } as unknown as VpnProvider;
}

let app: FastifyInstance;
let ctx: AppContext;
let cookieHeader: string;
let tmpDir: string;
let nodeId: string;

const H = () => ({ cookie: cookieHeader, 'content-type': 'application/json' });

function setWatchdogRemembered(): void {
  const wd = ctx.services.watchdog as unknown as {
    lastConnectedProfileId: string | null;
    lastConnectedProviderId: string | null;
  };
  wd.lastConnectedProfileId = 'p-handover';
  wd.lastConnectedProviderId = 'wireguard';
}

function watchdogRemembered(): string | null {
  return (ctx.services.watchdog as unknown as { lastConnectedProfileId: string | null }).lastConnectedProfileId;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-handover-'));
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

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/nodes/import',
    headers: H(),
    payload: { configs: [NODE_LINK] },
  });
  expect(created.statusCode).toBe(201);
  nodeId = (created.json() as { nodeIds: string[] }).nodeIds[0]!;
  // Tunnelable (a proxy median exists) but undialable by any local core: the
  // tunnel's preflight refuses instantly, so this test never spawns a binary
  // and still exercises the full route including the handover that runs first.
  ctx.repos.publicNodes.update(nodeId, { protocol: 'wireguard' });
  ctx.repos.publicNodes.updateTestStats(nodeId, { medianProxyMs: 120 });

  ctx.vpn.register(fakeEngineProvider());
  ctx.vpn.addProfile('wireguard', {
    id: 'p-handover',
    name: 'Handover profile',
    protocol: 'wireguard',
    endpoint: '203.0.113.10:51820',
    publicKeyFingerprint: null,
    allowedIps: null,
    dns: null,
    secretRef: 'wg-handover',
    configPath: '/x',
    createdAt: Date.now(),
  });
});

afterAll(async () => {
  await app.close();
  ctx.db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('mode handover — one writer for the machine network', () => {
  it('starting the proxy tunnel disconnects a connected engine first and acknowledges the watchdog', async () => {
    engine.connected = true;
    setWatchdogRemembered();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vpn/tunnel/start',
      headers: H(),
      payload: { nodeId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tunnel: { state: string } };
    // Handover ran BEFORE the tunnel's start; the start then failed preflight
    // (wireguard has no local proxy core) — honest `down`, no fake tunnel.
    expect(body.tunnel.state).toBe('down');
    expect(engine.disconnects, 'the connected engine was not disconnected before the switch').toBe(1);
    expect(watchdogRemembered(), 'the watchdog would resurrect the engine mid-switch').toBeNull();

    const events = await app.inject({ method: 'GET', url: '/api/v1/events?limit=50', headers: H() });
    expect(events.statusCode).toBe(200);
    expect(events.body, 'the handover was not recorded for the user to see').toContain(
      'hand the network over to the proxy tunnel',
    );
  });

  it('a deliberate disconnect stops the engine, the non-idle tunnel, and the watchdog together', async () => {
    engine.connected = true;
    setWatchdogRemembered();
    // The previous test left the tunnel `down` — non-idle, so disconnect owns it too.

    const res = await app.inject({ method: 'POST', url: '/api/v1/vpn/disconnect', headers: H() });
    expect(res.statusCode).toBe(200);
    expect(engine.disconnects, 'the engine was not disconnected').toBe(2);
    expect(watchdogRemembered(), 'disconnect must clear the watchdog so nothing reconnects').toBeNull();
    expect(ctx.services.tunnel.getStatus().state, 'disconnect must also stop the proxy tunnel').toBe('idle');
  });

  it('connecting an engine profile stops a non-idle proxy tunnel first', async () => {
    engine.connected = false;
    // Bring the tunnel to a (failed) start so it is non-idle again.
    const start = await app.inject({
      method: 'POST',
      url: '/api/v1/vpn/tunnel/start',
      headers: H(),
      payload: { nodeId },
    });
    expect((start.json() as { tunnel: { state: string } }).tunnel.state).toBe('down');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vpn/connect',
      headers: H(),
      payload: { profileId: 'p-handover' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: { connected: boolean } }).status.connected).toBe(true);
    expect(engine.connects, 'the engine profile did not connect').toBe(1);
    expect(ctx.services.tunnel.getStatus().state, 'the tunnel was not stopped before the engine took over').toBe(
      'idle',
    );
  });
});
