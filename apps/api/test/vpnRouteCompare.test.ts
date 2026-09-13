import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';

import type { FastifyInstance } from 'fastify';

/**
 * Direct-vs-VPN route comparison — built ONLY from stored route tests.
 *
 * Rules under test (FEATURE_GAPS: before/after VPN route comparison):
 *   - each stored trace carries the VPN tag captured at run time
 *   - pairing requires the SAME target (host or resolved IP)
 *   - missing sides are reported (unpaired/unavailable), never invented
 *   - deltas are VPN − direct, with an honest "no significant difference"
 *     note when scores are within 10 points
 */

let app: FastifyInstance;
let ctx: { repos: { tests: { create(id: string, type: 'route', params: object): void; finish(id: string, r: object): void } } };
let tmpDir: string;
const token = 'b'.repeat(64);

function tracePayload(target: string, opts: { hops: number; latency: number; score: number; loss?: number }) {
  const hops = Array.from({ length: opts.hops }, (_, i) => ({
    hop: i + 1,
    ip: `10.0.0.${i + 1}`,
    hostname: null,
    latencyMs: Math.round(opts.latency / opts.hops * 10) / 10,
    packetLoss: 0,
    asn: null,
    org: null,
    country: null,
    status: 'ok',
  }));
  return {
    testId: 'x',
    trace: { target, resolvedIp: '93.184.216.34', family: 4, hops, totalHops: opts.hops, totalLatencyMs: opts.latency },
    analysis: { score: opts.score, label: opts.score >= 70 ? 'good' : 'fair', findings: [] },
    lossPctAtDestination: opts.loss ?? 0,
  };
}

const auth = { Authorization: `Bearer ${token}` };

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-vpnroute-'));
  const built = await buildApp({
    configOverrides: {
      dataDir: tmpDir,
      dbPath: path.join(tmpDir, 'test.db'),
      tokenFile: path.join(tmpDir, 'token'),
      webDist: path.join(tmpDir, 'no-dist'),
      isTest: true,
    },
    daemonToken: token,
  });
  app = built.app;
  ctx = built.ctx as unknown as typeof ctx;
  await app.ready();

  // Seed stored traces directly through the same persistence path the
  // service uses: vpn=true trace (slower, more hops), direct trace, plus
  // one for a DIFFERENT target that must never pair.
  const repo = (app as unknown as { repos?: never }).repos; // not used; seed via service below
  void repo;
});

afterAll(async () => {
  await app.close();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* WAL handle release can race on Windows */
  }
});

/** Insert a finished route test the way RouteService.runTrace does. */
function seedRouteTest(id: string, target: string, vpn: boolean, latency: number, score: number) {
  const deps = ctx.repos.tests;
  deps.create(id, 'route', {
    target,
    resolvedIp: '93.184.216.34',
    vpn: { connected: vpn, providerId: vpn ? 'wireguard' : null, verifiedPublicIp: vpn ? '185.65.134.72' : null },
  });
  deps.finish(id, { status: 'done', summary: { hops: 9, totalLatencyMs: latency, score }, result: tracePayload(target, { hops: vpn ? 11 : 9, latency, score }) });
}

describe('direct vs VPN route comparison', () => {
  it('history endpoint lists stored traces with VPN tags', async () => {
    seedRouteTest('t1', 'example.com', false, 30, 80);
    seedRouteTest('t2', 'example.com', true, 45, 72);
    seedRouteTest('t3', 'other.example', false, 20, 90);

    const res = await app.inject({ method: 'GET', url: '/api/v1/route-compare/vpn/history', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.routes).toHaveLength(3);
    const vpnRow = body.routes.find((r: { id: string }) => r.id === 't2');
    expect(vpnRow.vpn).toEqual({ connected: true, providerId: 'wireguard', verifiedPublicIp: '185.65.134.72' });
    const directRow = body.routes.find((r: { id: string }) => r.id === 't1');
    expect(directRow.vpn.connected).toBe(false);
  });

  it('pairs same-target traces and computes honest deltas', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/route-compare/vpn?target=example.com', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('complete');
    expect(body.direct.testId).toBe('t1');
    expect(body.vpn.testId).toBe('t2');
    expect(body.deltas.latencyDeltaMs).toBe(15); // 45 - 30
    expect(body.deltas.hopsDelta).toBe(2); // 11 - 9
    expect(body.deltas.scoreDelta).toBe(-8);
    // within 10 points: no invented winner
    expect(body.deltas.preferred).toBeNull();
    expect(body.deltas.reason).toContain('not meaningful');
  });

  it('pairs by resolved IP as well as hostname', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/route-compare/vpn?target=93.184.216.34', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('complete');
  });

  it('never pairs a different target (unavailable, with guidance)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/route-compare/vpn?target=never-traced.example', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('unavailable');
    expect(body.direct).toBeNull();
    expect(body.vpn).toBeNull();
    expect(body.note).toContain('No stored traceroutes');
  });

  it('reports unpaired states instead of inventing a side', async () => {
    // Only vpn=true traces for 'vpn-only.example'
    seedRouteTest('t4', 'vpn-only.example', true, 50, 75);
    const res = await app.inject({ method: 'GET', url: '/api/v1/route-compare/vpn?target=vpn-only.example', headers: auth });
    const body = res.json();
    expect(body.status).toBe('unpaired_direct');
    expect(body.vpn).not.toBeNull();
    expect(body.direct).toBeNull();
    expect(body.deltas).toBeNull();
    expect(body.note).toContain('Disconnect');
  });

  it('prefers the higher-scoring side only when the gap is meaningful', async () => {
    // Direct much worse than VPN: score gap of 25
    seedRouteTest('t5', 'bad-direct.example', false, 90, 40);
    seedRouteTest('t6', 'bad-direct.example', true, 95, 65);
    const res = await app.inject({ method: 'GET', url: '/api/v1/route-compare/vpn?target=bad-direct.example', headers: auth });
    const body = res.json();
    expect(body.status).toBe('complete');
    expect(body.deltas.preferred).toBe('vpn');
    expect(body.deltas.reason).toContain('25 points higher');
  });

  it('rejects invalid targets', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/route-compare/vpn?target=', headers: auth });
    expect(res.statusCode).toBe(400);
  });
});
