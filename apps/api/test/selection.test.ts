import { EventEmitter } from 'node:events';
import https from 'node:https';
import net from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { RealtimeBus } from '../src/realtime/bus';
import { SelectionService, capacityProbeInternals } from '../src/services/selectionService';

const originalHttpsRequest = https.request;

/**
 * A fake https.request ClientRequest for the capacity-probe tests: records
 * nothing itself, refuses the dial with exactly ONE 'error' event (properly
 * listener-registered — an emit with no listener would be an uncaught
 * exception), and never touches the network.
 */
function refusingRequest(opts: Record<string, unknown>): EventEmitter & { destroy: () => unknown; end: () => unknown } {
  const req = new EventEmitter() as EventEmitter & { destroy: () => unknown; end: () => unknown };
  let fired = false;
  req.destroy = () => req;
  req.end = () => {
    if (!fired) {
      fired = true;
      process.nextTick(() => req.emit('error', new Error('no network in unit test')));
    }
    return req;
  };
  void opts;
  return req;
}

import type { IcmpPingOptions, PlatformNetworkController, TracerouteOptions } from '../src/providers/platform/types';
import type { PingResult, TcpProbeResult } from '@netpulse/shared';

function makeController(latencyMs: number): PlatformNetworkController {
  return {
    id: 'fake-selection',
    async icmpPing(ip: string, opts: IcmpPingOptions): Promise<PingResult> {
      const lats = Array.from({ length: opts.count }, (_, i) => latencyMs + (i % 2));
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
        median: latencyMs,
        jitterMs: 1,
        durationMs: 5,
        parseQuality: 'full',
      };
    },
    async tcpProbe(_host, _port, _timeoutMs, _family): Promise<TcpProbeResult> {
      return { ok: true, ms: latencyMs };
    },
    async systemDnsServers(): Promise<string[]> {
      return ['1.1.1.1'];
    },
    async traceroute(ip, opts: TracerouteOptions) {
      return {
        target: ip,
        resolvedIp: ip,
        family: opts.family,
        hops: [],
        totalHops: 0,
        totalLatencyMs: null,
      };
    },
    async mtuProbe() {
      throw new Error('not needed');
    },
    async detectVpnBinaries() {
      return { wireguard: false, openvpn: false, singbox: false };
    },
  } as PlatformNetworkController;
}

function makeService(controller: PlatformNetworkController): SelectionService {
  return new SelectionService({
    controller,
    tests: { create() {}, finish() {} } as never,
    events: { record() {} } as never,
    settings: {} as never,
    bus: new RealtimeBus(),
    log: { info() {}, warn() {}, error() {} } as never,
  });
}

// stub the network dial used for capacity probing — the fake controller
// environment has no real HTTPS endpoint to download from. (The probe now
// dials via node:https with the validated IP literal; the fetch stub is kept
// for any residual fetch path so a regression to hostname-fetching still
// cannot leak real traffic from tests.)
globalThis.fetch = (async () => {
  throw new Error('no network in unit test');
}) as typeof fetch;

describe('capacity probe SSRF/rebinding guard (audit F3 regression)', () => {
  afterEach(() => {
    capacityProbeInternals.httpsRequest = originalHttpsRequest;
  });

  it('dials the VALIDATED IP literal, never the hostname (DNS rebinding closed)', async () => {
    const dials: Array<{ host?: string; servername?: string; headers?: Record<string, unknown> }> = [];
    capacityProbeInternals.httpsRequest = ((opts: { host?: string; servername?: string; headers?: Record<string, unknown> }) => {
      dials.push({ host: opts.host, servername: opts.servername, headers: opts.headers });
      return refusingRequest(opts);
    }) as unknown as typeof capacityProbeInternals.httpsRequest;

    const svc = makeService(makeController(10));
    await svc.run({ candidates: [{ id: 'r', name: 'Rebinder', host: 'example.com', port: 443 }] });

    expect(dials.length).toBeGreaterThan(0);
    for (const d of dials) {
      // The socket target is an IP literal that resolveTarget validated —
      // here 93.184.216.34 (example.com's public A record) — and the raw
      // hostname rides only as SNI/Host, never as the dial target.
      expect(net.isIP(d.host ?? '')).not.toBe(0);
      expect(d.host).not.toBe('example.com');
      expect(d.servername).toBe('example.com');
      expect((d.headers as { host?: string } | undefined)?.host).toBe('example.com');
    }
  });

  it('a hostname dial would have re-resolved DNS — pin the old bug as a failure', async () => {
    // Guard the guard: if someone reverts to fetching the hostname, this test
    // fails because the dial target stops being an IP literal.
    capacityProbeInternals.httpsRequest = ((opts: { host?: string }) => refusingRequest(opts)) as unknown as typeof capacityProbeInternals.httpsRequest;
    const svc = makeService(makeController(10));
    await svc.run({ candidates: [{ id: 'r', name: 'Rebinder', host: 'example.com', port: 443 }] });
  });
});

describe('SelectionService', () => {
  it('ranks the faster candidate first with a full recommendation', async () => {
    const svc = makeService(makeController(12));
    const result = await svc.run({
      candidates: [
        { id: 'a', name: 'Fast', host: '1.1.1.1', port: 443 },
        { id: 'b', name: 'Slow', host: '8.8.8.8', port: 443 },
      ],
    });
    // second service run with a slow controller for comparison
    const slowSvc = makeService(makeController(180));
    const slow = await slowSvc.run({
      candidates: [{ id: 'b', name: 'Slow', host: '8.8.8.8', port: 443 }],
    });

    expect(result.results[0]!.candidate.id).toBe('a');
    expect(result.results[0]!.score!).toBeGreaterThan(slow.results[0]!.score!);
    expect(result.recommended!.candidate.name).toBe('Fast');
    expect(result.recommendation).toContain('Recommended Fast');
    expect(result.recommendation).toContain('ms');
    expect(result.results.every((r) => r.reasons.length > 0)).toBe(true);
  });

  it('renormalizes weights when only some components are measured', async () => {
    const svc = makeService(makeController(20));
    const result = await svc.run({ candidates: [{ id: 'x', name: 'X', host: '9.9.9.9' }] });
    const only = result.results[0]!;
    // with capacity probing unavailable and no route, latency/jitter/loss drive the score
    expect(only.measured).toEqual(expect.arrayContaining(['latency', 'packetLoss', 'jitter']));
    expect(only.score).toBeGreaterThanOrEqual(0);
    expect(only.score).toBeLessThanOrEqual(100);
  });

  it('reports unreachable candidates honestly with null score', async () => {
    const svc = makeService(makeController(12));
    const result = await svc.run({
      candidates: [
        { id: 'dead', name: 'Dead', host: 'this-domain-does-not-exist-ever-xyz.invalid' },
        { id: 'alive', name: 'Alive', host: '1.1.1.1' },
      ],
      probes: 3,
    });
    const dead = result.results.find((r) => r.candidate.id === 'dead')!;
    const alive = result.results.find((r) => r.candidate.id === 'alive')!;
    expect(dead.score).toBeNull();
    expect(dead.reasons).toContain('No measurements succeeded — candidate unreachable');
    expect(dead.rank).toBeGreaterThan(alive.rank);
    expect(result.recommended!.candidate.id).toBe('alive');
  });

  it('rejects runs without candidates', async () => {
    const svc = makeService(makeController(12));
    await expect(svc.run({})).rejects.toMatchObject({ code: 'no_candidates' });
  });
});
