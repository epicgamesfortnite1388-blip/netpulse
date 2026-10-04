import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/routes/context';
import type { IcmpPingOptions, PlatformNetworkController } from '../src/providers/platform/types';
import type { PingResult, TcpProbeResult } from '@netpulse/shared';

class FakeController implements PlatformNetworkController {
  readonly id = 'fake';

  async icmpPing(ip: string, opts: IcmpPingOptions): Promise<PingResult> {
    const lats = Array.from({ length: opts.count }, (_, i) => 18 + i);
    return {
      method: 'icmp',
      target: ip,
      resolvedIp: ip,
      family: opts.family ?? 4,
      samples: lats.map((ms, i) => ({ seq: i + 1, ok: true, ms })),
      sent: opts.count,
      received: opts.count,
      lossPct: 0,
      min: Math.min(...lats),
      avg: lats.reduce((a, b) => a + b, 0) / lats.length,
      max: Math.max(...lats),
      median: 19,
      jitterMs: 1.2,
      durationMs: 5,
      parseQuality: 'full',
    };
  }

  async tcpProbe(_host: string, _port: number, _timeoutMs: number, _family?: 4 | 6): Promise<TcpProbeResult> {
    return { ok: true, ms: 18 };
  }

  async systemDnsServers(): Promise<string[]> {
    return ['1.1.1.1'];
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-test-'));
  const built = await buildApp({
    configOverrides: {
      dataDir: tmpDir,
      dbPath: path.join(tmpDir, 'test.db'),
      tokenFile: path.join(tmpDir, 'token'),
      webDist: path.join(tmpDir, 'no-dist'),
      isTest: true,
    },
    controller: new FakeController(),
  });
  app = built.app;
  ctx = built.ctx;

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/session',
    remoteAddress: '127.0.0.1',
  });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === 'netpulse_session');
  expect(cookie).toBeDefined();
  cookieHeader = `netpulse_session=${cookie!.value}`;
});

afterAll(async () => {
  await app.close();
  ctx.db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const authed = {
  method: 'GET',
  headers: {} as Record<string, string>,
};

function get(url: string) {
  return app.inject({ method: 'GET', url, headers: { cookie: cookieHeader } });
}

describe('auth', () => {
  it('rejects unauthenticated API calls', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('keeps /meta public', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/meta' });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('NetPulse');
  });

  it('refuses sessions from non-loopback addresses', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      remoteAddress: '203.0.113.50',
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects cookie-authenticated mutations from foreign origins (CSRF)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: { cookie: cookieHeader, origin: 'https://evil.example' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf_rejected');
  });

  it('accepts daemon tokens', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: { authorization: `Bearer ${fs.readFileSync(path.join(tmpDir, 'token'), 'utf8').trim()}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('settings', () => {
  it('returns defaults initially', async () => {
    const res = await get('/api/v1/settings');
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.optimization.weights.latency).toBe(30);
  });

  it('persists updates and validates', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: { cookie: cookieHeader, origin: 'http://localhost:5173' },
      payload: {
        diagnostics: { pingCount: 25 },
        optimization: {
          weights: { latency: 40, packetLoss: 15, jitter: 15, throughput: 20, routeQuality: 5, load: 5 },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.diagnostics.pingCount).toBe(25);
    expect(res.json().settings.general.theme).toBe('dark');

    const bad = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: { cookie: cookieHeader, origin: 'http://localhost:5173' },
      payload: { optimization: { weights: { latency: 90, packetLoss: 0, jitter: 0, throughput: 0, routeQuality: 0, load: 0 } } },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('ping-test', () => {
  it('runs a real test against a public target and records history', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ping-test',
      headers: { cookie: cookieHeader },
      payload: { target: '1.1.1.1', count: 4 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.avg).toBeGreaterThan(0);
    expect(body.result.lossPct).toBe(0);
    expect(body.result.samples).toHaveLength(4);

    const history = await get('/api/v1/history?type=ping');
    expect(history.json().tests).toHaveLength(1);
    expect(history.json().tests[0].summary.lossPct).toBe(0);
  });

  it('blocks private targets (SSRF guard)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ping-test',
      headers: { cookie: cookieHeader },
      payload: { target: '192.168.1.1' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('private_target_not_allowed');
  });

  it('rejects malformed payloads', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ping-test',
      headers: { cookie: cookieHeader },
      payload: { target: '1.1.1.1', count: 'lots' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });
});

describe('events', () => {
  it('records events from tests', async () => {
    const res = await get('/api/v1/events?limit=10');
    expect(res.statusCode).toBe(200);
    const events = res.json().events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e: { message: string }) => e.message.includes('Ping test'))).toBe(true);
  });

  it('filters by level', async () => {
    const res = await get('/api/v1/events?level=info&limit=5');
    expect(res.json().events.every((e: { level: string }) => e.level === 'info')).toBe(true);
  });
});

describe('servers CRUD', () => {
  it('creates, lists, patches and deletes servers', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { cookie: cookieHeader },
      payload: {
        name: 'My VPS',
        kind: 'vps',
        host: '203.0.113.10',
        tags: ['edge'],
        capabilities: ['diag'],
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().server.id;

    const list = await get('/api/v1/servers');
    expect(list.json().servers).toHaveLength(1);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/servers/${id}`,
      headers: { cookie: cookieHeader },
      payload: { name: 'My VPS renamed' },
    });
    expect(patched.json().server.name).toBe('My VPS renamed');

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${id}`,
      headers: { cookie: cookieHeader },
    });
    expect(removed.statusCode).toBe(200);
  });

  it('404s for unknown servers', async () => {
    const res = await get('/api/v1/servers/nope');
    expect(res.statusCode).toBe(404);
  });
});

describe('vpn contract', () => {
  it('reports disconnected status and validates connect payloads', async () => {
    const status = await get('/api/v1/vpn/status');
    expect(status.json().connected).toBe(false);
    expect(typeof status.json().supported).toBe('boolean');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vpn/connect',
      headers: { cookie: cookieHeader },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });
});

describe('ip endpoint', () => {
  it('validates family parameter', async () => {
    const bad = await get('/api/v1/ip?family=8');
    expect(bad.statusCode).toBe(400);
  });
});

describe('history detail', () => {
  it('returns null for unknown ids without 404', async () => {
    const res = await get('/api/v1/history/does-not-exist');
    expect(res.statusCode).toBe(200);
    expect(res.json().test).toBeNull();
  });

  it('persists the full result payload, not just the summary', async () => {
    const run = await app.inject({
      method: 'POST',
      url: '/api/v1/ping-test',
      headers: { cookie: cookieHeader },
      payload: { target: '1.1.1.1', count: 4 },
    });
    expect(run.statusCode).toBe(200);
    const testId = run.json().result.testId as string;

    const res = await get(`/api/v1/history/${testId}`);
    expect(res.statusCode).toBe(200);
    const test = res.json().test;
    // full payload survives in the record (per-sample detail the summary omits)
    expect(test.result.testId).toBe(testId);
    expect(test.result.samples).toHaveLength(4);
    expect(test.result.avg).toBeGreaterThan(0);
    // summary is still the compact projection
    expect(test.summary.samples).toBeUndefined();
  });

  it('keeps the history list light (no full payloads)', async () => {
    const res = await get('/api/v1/history?type=ping&limit=50');
    expect(res.statusCode).toBe(200);
    for (const row of res.json().tests) {
      expect(row.result).toBeUndefined();
    }
  });
});

describe('gaming VPN-aware comparison', () => {
  const insert = (gameId: string, mode: 'direct' | 'vpn', latencyMs: number, jitterMs: number) => {
    const testId = `t-${gameId}-${mode}`;
    ctx.repos.tests.create(testId, 'gaming', { gameId, mode });
    ctx.repos.tests.finish(testId, { status: 'done', summary: { gameId, mode } });
    ctx.repos.gaming.insertComparison({
      id: `cmp-${gameId}-${mode}`,
      testId,
      gameId,
      mode,
      serverName: mode === 'vpn' ? 'wg-test' : null,
      latencyMs,
      jitterMs,
      lossPct: null,
      score: null,
      notes: null,
    });
  };

  it('withholds a winner when the delta is within the measured jitter', async () => {
    insert('valorant', 'direct', 40, 5);
    insert('valorant', 'vpn', 38, 5);
    const result = await ctx.services.gaming.comparisonFor('valorant');
    expect(result.winner).toBeNull();
    expect(result.reason).toContain('within measurement noise');
  });

  it('recommends the switch when the delta exceeds jitter', async () => {
    insert('league-of-legends', 'direct', 40, 5);
    insert('league-of-legends', 'vpn', 12, 4);
    const result = await ctx.services.gaming.comparisonFor('league-of-legends');
    expect(result.winner).toBe('vpn');
    expect(result.differenceMs).toBe(28);
    expect(result.reason).toContain('beyond the measured jitter');
  });
});

describe('nodes route hardening', () => {
  // NOTE: the first test below needs an EMPTY node table; later tests insert
  // the fixture. Vitest runs `it`s in declaration order — keep that order.
  const insertNode = () => {
    const existing = ctx.repos.publicNodes.get('node-ssrf-test');
    if (existing) return existing;
    const now = Date.now();
    const row = {
      id: 'node-ssrf-test',
      canonicalFingerprint: 'fp-ssrf-test',
      protocol: 'vless' as const,
      host: 'example.com',
      ipv4: [] as string[],
      ipv6: [] as string[],
      port: 443,
      transport: 'ws',
      security: 'tls',
      sni: null,
      alpn: [] as string[],
      fingerprint: null,
      flow: null,
      alterId: null,
      path: null,
      hostHeader: null,
      serviceName: null,
      allowInsecure: false,
      realityPublicKey: null,
      realityShortId: null,
      realityServerName: null,
      encryption: null,
      ssrProtocol: null,
      remark: null,
      sourceIds: [] as string[],
      sourceUrls: [] as string[],
      sourceCount: 1,
      firstSeen: now,
      lastSeen: now,
      lastValidated: null,
      status: 'healthy',
      confidence: 'high',
      country: 'US',
      city: null,
      asn: null,
      isp: null,
      organization: null,
      lat: null,
      lon: null,
      geoSourceCount: 0,
      tags: [] as string[],
      favorite: false,
      userNotes: null,
      lastProxyMs: null,
      lastTcpMs: null,
      lastTlsMs: null,
      testCount: 0,
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
      recentTestCount: 0,
      recentSuccessCount: 0,
      recentFailureCount: 0,
      score: 0,
      reliabilityPct: 0,
      medianProxyMs: null,
      medianTcpMs: null,
      medianTlsMs: null,
      recentLossPct: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      freshness: 'fresh',
      createdAt: now,
      updatedAt: now,
    };
    ctx.repos.publicNodes.insert(row);
    return row;
  };

  it('does not create a running scan job when targets resolve empty', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/scanner/start',
      headers: { cookie: cookieHeader },
      payload: { kind: 'test' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('no_targets');
    expect(res.json().error.message).toBe(
      'Provide nodeIds or a filter that matches at least one node.',
    );
    for (const job of ctx.repos.scanJobs.list(100)) {
      expect(job.status).not.toBe('running');
    }
  });

  it('rejects a private-IP override on node test (SSRF guard)', async () => {
    insertNode();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes/node-ssrf-test/test',
      headers: { cookie: cookieHeader },
      payload: { type: 'tcp', ip: '127.0.0.1' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('private_target_not_allowed');
  });

  it('rejects a link-local metadata override on node test (SSRF guard)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes/node-ssrf-test/test',
      headers: { cookie: cookieHeader },
      payload: { type: 'tcp', ip: '169.254.169.254' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('private_target_not_allowed');
  });

  it('returns 400 for an invalid test type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes/node-ssrf-test/test',
      headers: { cookie: cookieHeader },
      payload: { type: 'gopher' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 (not 500) for a missing body on favorite toggle', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes/node-ssrf-test/favorite',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 (not 500) for a missing body on batch test', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes/test-batch',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(400);
  });

  it('runs a scanner start with explicit nodeIds and finishes cleanly', async () => {
    insertNode();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/scanner/start',
      headers: { cookie: cookieHeader },
      payload: { kind: 'test', nodeIds: ['node-ssrf-test'], concurrency: 1 },
    });
    expect(res.statusCode).toBe(200);
    const { jobId } = res.json() as { jobId: string };
    expect(jobId).toBeTruthy();

    // Wait for the async scan to settle (few targets finish quickly).
    let job: { status: string; tested?: number } | undefined;
    for (let i = 0; i < 50 && (!job || job.status === 'running'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      job = ctx.repos.scanJobs.get(jobId) as { status: string; tested?: number } | undefined;
    }
    expect(job?.status).toBe('completed');
    expect(job?.tested).toBe(1);
  });
});

export { authed };
