import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/routes/context';
import type { PlatformNetworkController } from '../src/providers/platform/types';

/** Minimal controller: never touches the network for these endpoint tests. */
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

let app: FastifyInstance;
let ctx: AppContext;
let cookieHeader: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-netlab-'));
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

describe('DNS resolver catalog API', () => {
  it('serves provider groups from the data-driven catalog', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/dns/providers', headers: { cookie: cookieHeader } });
    expect(res.statusCode).toBe(200);
    const { groups, total } = res.json();
    expect(groups.length).toBeGreaterThanOrEqual(10);
    expect(total).toBeGreaterThan(20);
    const ids = new Set<string>();
    for (const g of groups) {
      expect(g.id).toBeTruthy();
      for (const r of g.resolvers) {
        expect(ids.has(r.id), `duplicate id ${r.id}`).toBe(false);
        ids.add(r.id);
        expect(typeof r.verified).toBe('boolean');
      }
    }
  });

  it('rejects custom resolvers with metadata/private addresses', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/dns/providers/custom',
      headers: { cookie: cookieHeader },
      payload: { id: 'evil', name: 'metadata', ipv4: '169.254.169.254', ipv6: null, dohUrl: null, dotHost: null, dnssec: false },
    });
    expect(res.statusCode).toBe(400);

    const loopback = await app.inject({
      method: 'POST',
      url: '/api/v1/dns/providers/custom',
      headers: { cookie: cookieHeader },
      payload: { id: 'loop', name: 'loopback', ipv4: '127.0.0.1', ipv6: null, dohUrl: null, dotHost: null, dnssec: false },
    });
    expect(loopback.statusCode).toBe(400);
  });

  it('adds and removes a legitimate public custom resolver', async () => {
    const added = await app.inject({
      method: 'POST',
      url: '/api/v1/dns/providers/custom',
      headers: { cookie: cookieHeader },
      payload: { id: 'lab', name: 'Lab DoH', ipv4: '8.8.8.8', ipv6: null, dohUrl: 'https://dns.google/dns-query', dotHost: 'dns.google', dnssec: true },
    });
    expect(added.statusCode).toBe(200);
    const addedBody = added.json();
    expect(addedBody.added.kind).toBe('custom');
    expect(addedBody.added.category).toBe('custom');

    const list = await app.inject({ method: 'GET', url: '/api/v1/dns/providers/custom', headers: { cookie: cookieHeader } });
    expect(list.json().some((r: { id: string }) => r.id === 'custom-lab')).toBe(true);

    const removed = await app.inject({ method: 'DELETE', url: '/api/v1/dns/providers/custom/lab', headers: { cookie: cookieHeader } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().removed).toBe(true);
  });

  it('rejects unknown resolvers for DNSSEC deep checks cleanly', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/dns/providers/does-not-exist/dnssec-deep',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().providerId).toBe('does-not-exist');
  });
});

describe('gaming catalog API', () => {
  it('serves the game catalog with documented endpoints', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/gaming/games', headers: { cookie: cookieHeader } });
    expect(res.statusCode).toBe(200);
    const { games, note } = res.json();
    expect(games.length).toBeGreaterThanOrEqual(15);
    expect(note).toContain('not equal in-game server RTT');
    const valorant = games.find((g: { id: string }) => g.id === 'valorant');
    expect(valorant).toBeDefined();
    expect(valorant.regions.map((r: { id: string }) => r.id)).toEqual(['na', 'eu', 'asia', 'sea']);
    expect(valorant.endpoints.length).toBeGreaterThanOrEqual(8);

    // every bundled endpoint carries a documented source
    for (const g of games) {
      for (const e of g.endpoints) {
        expect(e.hostname, `${g.id} endpoint without source`).toBeTruthy();
        expect(e.source, `${g.id} endpoint without a documented source`).toBeTruthy();
        if (e.verified) expect(e.verifiedAt, `${g.id} verified endpoint missing verifiedAt`).toBeGreaterThan(0);
      }
    }
  });

  it('expands region coverage with documented regional endpoints', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/gaming/games', headers: { cookie: cookieHeader } });
    const games = res.json().games;
    const byId = (id: string) => games.find((g: { id: string }) => g.id === id);

    const ffxiv = byId('final-fantasy-xiv');
    expect(ffxiv.regions.map((r: { id: string }) => r.id)).toEqual(['na', 'eu', 'jp']);
    expect(ffxiv.endpoints.filter((e: { verified: boolean }) => e.verified).length).toBe(3);

    const battleNet = byId('battle-net');
    expect(battleNet.regions.map((r: { id: string }) => r.id)).toContain('cn');
    expect(battleNet.endpoints.some((e: { hostname: string }) => e.hostname === 'gateway.battlenet.com.cn')).toBe(true);
    expect(battleNet.endpoints.filter((e: { purpose: string }) => e.purpose === 'login').length).toBeGreaterThanOrEqual(4);

    const wow = byId('world-of-warcraft');
    expect(wow.regions.map((r: { id: string }) => r.id)).toContain('cn');
    const overwatch = byId('overwatch-2');
    expect(overwatch.endpoints.filter((e: { purpose: string }) => e.purpose === 'login').length).toBeGreaterThanOrEqual(3);

    // region-tagged endpoints cover more servers per region
    const regionEndpoints = new Map<string, number>();
    for (const g of games) {
      for (const e of g.endpoints) {
        if (e.region) regionEndpoints.set(e.region, (regionEndpoints.get(e.region) ?? 0) + 1);
      }
    }
    expect(regionEndpoints.get('na') ?? 0).toBeGreaterThanOrEqual(2);
    expect(regionEndpoints.get('eu') ?? 0).toBeGreaterThanOrEqual(2);
    expect(regionEndpoints.get('asia') ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('looks up a single game', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/gaming/games/minecraft', headers: { cookie: cookieHeader } });
    expect(res.statusCode).toBe(200);
    expect(res.json().game.publisher).toBe('Mojang Studios');
  });

  it('rejects unknown game tests with a 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/gaming/test',
      headers: { cookie: cookieHeader },
      payload: { gameId: 'half-life-3' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('capabilities endpoint', () => {
  it('reports platform capability states', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/meta/capabilities', headers: { cookie: cookieHeader } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(['supported', 'unavailable', 'requires-permission', 'unknown']).toContain(body.icmpPing.state);
    expect(body.tcpProbe.state).toBe('supported');
    expect(body.vpn).toHaveProperty('wireGuard');
  });
});
