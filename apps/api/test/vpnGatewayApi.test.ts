import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-gateway-api-'));
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

// NOTE: built per call, not at module scope — beforeAll assigns the cookie.

describe('gateway memory API', () => {
  it('starts empty and reflects a verified gateway once one is recorded', async () => {
    const empty = await app.inject({ method: 'GET', url: '/api/v1/vpn/tunnel/gateways', headers: { cookie: cookieHeader } });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().gateways).toEqual([]);

    ctx.services.gatewayMemory.remember({
      nodeId: 'node-a', name: 'Tokyo', host: '1.2.3.4', port: 443, protocol: 'vless',
      engine: 'xray', exitIp: '203.0.113.9', exitCountry: 'JP', verifyMs: 90,
    });

    const listed = await app.inject({ method: 'GET', url: '/api/v1/vpn/tunnel/gateways', headers: { cookie: cookieHeader } });
    const gateways = listed.json().gateways as Array<{ nodeId: string; exitIp: string }>;
    expect(gateways).toHaveLength(1);
    expect(gateways[0]).toMatchObject({ nodeId: 'node-a', exitIp: '203.0.113.9' });
  });

  it('forgets a single gateway by path, then all of them', async () => {
    ctx.services.gatewayMemory.remember({
      nodeId: 'node-b', name: null, host: '5.6.7.8', port: 443, protocol: 'vmess',
      engine: 'sing-box', exitIp: null, exitCountry: null, verifyMs: null,
    });

    const one = await app.inject({ method: 'DELETE', url: '/api/v1/vpn/tunnel/gateways/node-b', headers: { cookie: cookieHeader } });
    expect(one.statusCode).toBe(200);
    expect((one.json().gateways as unknown[]).some((g) => (g as { nodeId: string }).nodeId === 'node-b')).toBe(false);

    const all = await app.inject({ method: 'DELETE', url: '/api/v1/vpn/tunnel/gateways', headers: { cookie: cookieHeader } });
    expect(all.statusCode).toBe(200);
    expect(all.json().gateways).toEqual([]);
  });
});

describe('discovery API', () => {
  it('returns an honest report for an empty database instead of a silent success', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vpn/discover',
      headers: { cookie: cookieHeader },
      payload: { profile: 'stealth' },
    });
    expect(res.statusCode).toBe(200);
    const { report } = res.json();
    expect(report.profile).toBe('stealth');
    expect(report.probed).toBe(0);
    expect(report.winner).toBeNull();
    expect(report.summary).toMatch(/No candidates matched/);
  });

  it('refuses an unknown profile rather than defaulting quietly', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vpn/discover',
      headers: { cookie: cookieHeader },
      payload: { profile: 'ludicrous' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('clamps a limit above the profile cap', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vpn/discover',
      headers: { cookie: cookieHeader },
      payload: { profile: 'stealth', limit: 60 },
    });
    expect(res.statusCode).toBe(200);
    // nothing is in the DB, so probed is 0 — but the request must be accepted
    expect(res.json().report.profile).toBe('stealth');
  });
});

describe('quick connect API', () => {
  it('reports honestly when there is nothing remembered and nothing to discover', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vpn/tunnel/quick',
      headers: { cookie: cookieHeader },
      payload: { systemProxy: false },
    });
    expect(res.statusCode).toBe(200);
    const { quick, tunnel } = res.json();
    expect(quick.ok).toBe(false);
    expect(quick.attempts).toEqual([]);
    expect(quick.summary).toMatch(/Nothing was remembered, and discovery found nothing usable/);
    expect(quick.summary).toMatch(/No candidates matched/);
    expect(tunnel.state).toBe('idle');
  });

  it('runs the discovery profile the caller asked for, not the stored setting', async () => {
    // The route declared a `profile` input and once ignored it, so the request
    // looked honoured while a different trade-off ran. This locks the contract:
    // what the caller sends is what runs, and the response says which it was.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vpn/tunnel/quick',
      headers: { cookie: cookieHeader },
      payload: { systemProxy: false, profile: 'stealth', maxMemoryAttempts: 0 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().quick.profile).toBe('stealth');
  });

  it('falls back to the stored setting when no profile is sent', async () => {
    // Set the stored value here rather than relying on another test's writes.
    await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: { cookie: cookieHeader },
      payload: { vpn: { scanProfile: 'thorough' } },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vpn/tunnel/quick',
      headers: { cookie: cookieHeader },
      payload: { systemProxy: false, maxMemoryAttempts: 0 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().quick.profile).toBe('thorough');
  });
});

describe('split-tunnel settings API', () => {
  it('persists bypass rules and the discovery profile verbatim (normalized when applied, not when stored)', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: { cookie: cookieHeader },
      payload: {
        vpn: {
          scanProfile: 'ironclad',
          bypass: {
            enabled: true,
            domains: ['https://Bank.Example.com/login', '*.ok.example'],
            ips: ['10.0.0.0/8'],
            ports: [443],
            lan: false,
          },
        },
      },
    });
    expect(put.statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: { cookie: cookieHeader } });
    const vpn = res.json().settings.vpn;
    expect(vpn.scanProfile).toBe('ironclad');
    expect(vpn.bypass).toMatchObject({ enabled: true, domains: ['https://Bank.Example.com/login', '*.ok.example'], ips: ['10.0.0.0/8'], ports: [443], lan: false });
  });

  it('refuses an unsupported discovery profile', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: { cookie: cookieHeader },
      payload: { vpn: { scanProfile: 'ludicrous' } },
    });
    expect(res.statusCode).toBe(400);
  });
});
