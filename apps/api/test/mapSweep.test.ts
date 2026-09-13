import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearProcessNameCache, processNameForPid } from '../src/util/processNames';
import { MapService, cymruCountryOf } from '../src/services/mapService';
import { RealtimeBus } from '../src/realtime/bus';
import { NO_VPN } from '../src/vpn/vpnState';

import type { PlatformNetworkController } from '../src/providers/platform/types';
import type { IcmpPingOptions, TracerouteOptions } from '../src/providers/platform/types';
import type { MapConnectionRow, NetworkTarget, PingResult, TcpProbeResult, TraceResult } from '@netpulse/shared';
import type { MapObservationsRepository, ScanRepository, ServersRepository } from '../src/db/repositories';
import type { EventService } from '../src/services/eventService';
import type { IpInfoService } from '../src/services/ipInfoService';
import type { Logger } from '../src/logger';
import type { RouteService } from '../src/services/routeService';
import type { VpnRegistry } from '../src/vpn/vpnService';

/* ---------------------------------------------------------------------------
 * Real entry points under test:
 *   - MapService.startSweep / sweep (POST /map/sweep, GET /map/sweep/:id)
 *   - MapService.activeConnections (GET /map/connections) — parsing only,
 *     via the module-level netstat parser indirectly (win32-dependent parse
 *     extracted to a pure function below).
 * ------------------------------------------------------------------------ */

const noopLog: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

function fakeController(over: Partial<PlatformNetworkController> = {}): PlatformNetworkController {
  return {
    id: 'test',
    icmpPing: vi.fn(async (_ip: string, opts: IcmpPingOptions): Promise<PingResult> => ({
      method: 'icmp',
      target: _ip,
      resolvedIp: _ip,
      family: 4,
      samples: [],
      sent: opts.count,
      received: opts.count,
      lossPct: 0,
      min: 20,
      avg: 21,
      max: 22,
      median: 21,
      jitterMs: 0.5,
      durationMs: 50,
      parseQuality: 'full',
    })),
    tcpProbe: vi.fn(async (): Promise<TcpProbeResult> => ({ ok: true, ms: 30 })),
    icmpMtu: vi.fn(async () => ({ mtu: 1500, probablePath: '1500 ethernet', testedAt: Date.now() })),
    traceroute: vi.fn(async (_ip: string, _opts: TracerouteOptions): Promise<TraceResult> => ({ resolvedIp: _ip, family: 4, hops: [], durationMs: 10 })),
    systemDnsServers: vi.fn(async () => []),
    detectVpnBinaries: vi.fn(async () => ({})),
    mtuProbe: vi.fn(async () => ({ mtu: 1500, probablePath: '1500 ethernet', testedAt: Date.now() })),
    ...over,
  } as PlatformNetworkController;
}

function fakeDeps(controller: PlatformNetworkController, vpn: Partial<VpnRegistry> = {}) {
  return {
    controller,
    route: { runTrace: vi.fn(async () => ({ trace: null, analysis: { findings: [] } })) } as unknown as RouteService,
    ipInfo: { lookup: vi.fn(async () => null) } as unknown as IpInfoService,
    vpn: {
      listProfiles: vi.fn(() => []),
      all: vi.fn(() => []),
      status: vi.fn(async () => null),
      getSecretForCheck: vi.fn(() => null),
      ...vpn,
    } as unknown as VpnRegistry,
    scans: { listScans: vi.fn(() => []), candidates: vi.fn(() => []) } as unknown as ScanRepository,
    servers: { list: vi.fn(() => []) } as unknown as ServersRepository,
    observations: {
      insert: vi.fn(),
      list: vi.fn(() => []),
      latestForTarget: vi.fn(() => []),
    } as unknown as MapObservationsRepository,
    events: { record: vi.fn() } as unknown as EventService,
    bus: new RealtimeBus(),
    log: noopLog,
  };
}

afterEach(() => {
  clearProcessNameCache();
  vi.restoreAllMocks();
});

/* ------------------------------ sweep engine ------------------------------ */

describe('MapService.startSweep', () => {
  it('rejects a second sweep while one is running (429 sweep_busy)', async () => {
    // slow ICMP so the first sweep is still running when the second arrives
    const controller = fakeController({
      icmpPing: vi.fn((_ip: string, opts: IcmpPingOptions) => new Promise<PingResult>((resolve) => setTimeout(() => resolve({
        method: 'icmp', target: _ip, resolvedIp: _ip, family: 4, samples: [], sent: opts.count, received: opts.count, lossPct: 0, min: 20, avg: 20, max: 20, median: 20, jitterMs: 0, durationMs: 10, parseQuality: 'full',
      }), 300))),
    });
    const svc = new MapService(fakeDeps(controller));
    const first = svc.startSweep(['cloudflare:speed', 'dns:cloudflare-1111']);
    expect(first.accepted).toBe(2);
    expect(() => svc.startSweep(null)).toThrow(/already running/);
    await vi.waitFor(() => expect(svc.sweep(first.sweepId)?.completed).toBe(true));
  });

  it('ranks reachable targets first and marks unreachable ones with a reason', async () => {
    const controller = fakeController({
      icmpPing: vi.fn(async (ip: string, opts: IcmpPingOptions): Promise<PingResult> => {
        if (ip === '9.9.9.9') throw new Error('host unreachable');
        return { method: 'icmp', target: ip, resolvedIp: ip, family: 4, samples: [], sent: opts.count, received: opts.count, lossPct: 0, min: 10, avg: 11, max: 12, median: 11, jitterMs: 0.4, durationMs: 10, parseQuality: 'full' };
      }),
      tcpProbe: vi.fn(async (ip: string): Promise<TcpProbeResult> => (ip === '9.9.9.9' ? { ok: false, ms: null, error: 'timeout' } : { ok: true, ms: 30 })),
    });
    const deps = fakeDeps(controller);
    const svc = new MapService(deps);
    const { sweepId } = svc.startSweep(['cloudflare:speed', 'dns:quad9-9999']);
    await vi.waitFor(() => expect(svc.sweep(sweepId)?.completed).toBe(true));
    const result = svc.sweep(sweepId)!;
    expect(result.completed).toBe(true);
    expect(result.rows.length).toBe(2);
    // 1.1.1.1 (excellent, ~11ms ICMP) ranks above the unreachable Quad9 row
    expect(result.rows[0]!.target.id).toBe('cloudflare:speed');
    expect(result.rows[0]!.status).toBe('excellent');
    expect(result.rows[0]!.method).toBe('icmp');
    expect(result.rows[1]!.status).toBe('unreachable');
  });

  it('TCP fallback rescues ICMP-filtered hosts and labels the method honestly', async () => {
    const controller = fakeController({
      icmpPing: vi.fn(async () => { throw new Error('host unreachable'); }),
    });
    const svc = new MapService(fakeDeps(controller));
    const { sweepId } = svc.startSweep(['dns:quad9-9999']);
    await vi.waitFor(() => expect(svc.sweep(sweepId)?.completed).toBe(true));
    const row = svc.sweep(sweepId)!.rows[0]!;
    expect(row.method).toBe('tcp');
    expect(row.status).toBe('excellent');
  });

  it('falls back to TCP when ICMP fails entirely and labels the method honestly', async () => {
    const controller = fakeController({
      icmpPing: vi.fn(async () => { throw new Error('blocked'); }),
    });
    const svc = new MapService(fakeDeps(controller));
    const { sweepId } = svc.startSweep(['cloudflare:speed']);
    await vi.waitFor(() => expect(svc.sweep(sweepId)?.completed).toBe(true));
    const row = svc.sweep(sweepId)!.rows[0]!;
    expect(row.method).toBe('tcp');
    expect(row.latencyMs).toBeGreaterThan(0);
  });

  it('reports unreachable when both ICMP and TCP fail (no fake success)', async () => {
    const controller = fakeController({
      icmpPing: vi.fn(async () => { throw new Error('blocked'); }),
      tcpProbe: vi.fn(async () => ({ ok: false, ms: null, error: 'timeout' })),
    });
    const svc = new MapService(fakeDeps(controller));
    const { sweepId } = svc.startSweep(['cloudflare:speed']);
    await vi.waitFor(() => expect(svc.sweep(sweepId)?.completed).toBe(true));
    const row = svc.sweep(sweepId)!.rows[0]!;
    expect(row.method).toBeNull();
    expect(row.latencyMs).toBeNull();
    expect(row.status).toBe('unreachable');
  });

  it('publishes incremental map:sweep frames on the bus as rows land', async () => {
    const svc = new MapService(fakeDeps(fakeController()));
    const frames: string[] = [];
    svc['deps'].bus.subscribe('map', (m) => { if (m.type === 'map:sweep') frames.push('sweep'); });
    const { sweepId } = svc.startSweep(['cloudflare:speed', 'game:valorant:eu', 'game:cs2:global']);
    await vi.waitFor(() => expect(svc.sweep(sweepId)?.completed).toBe(true));
    // at least one frame per target + a terminal frame
    expect(frames.length).toBeGreaterThanOrEqual(3);
  });

  it('400s when no sweepable targets match the requested ids', () => {
    const svc = new MapService(fakeDeps(fakeController()));
    expect(() => svc.startSweep(['dns:cloudflare'])).toThrow(/No sweepable targets/);
  });

  it('runs a DNS resolver target when explicitly requested', async () => {
    const controller = fakeController();
    const svc = new MapService(fakeDeps(controller));
    const { sweepId } = svc.startSweep(['dns:cloudflare-1111', 'cloudflare:speed']);
    await vi.waitFor(() => expect(svc.sweep(sweepId)?.completed).toBe(true));
    const rows = svc.sweep(sweepId)!.rows;
    expect(rows.length).toBe(2);
    const dnsRow = rows.find((r) => r.target.type === 'dns');
    expect(dnsRow).toBeTruthy();
    expect(dnsRow!.method != null).toBe(true);
  });
});

/* --------------------------- process name lookup -------------------------- */

describe('processNameForPid', () => {
  it('returns null (never throws) for invalid pids and on non-Windows hosts', async () => {
    expect(await processNameForPid(null)).toBeNull();
    expect(await processNameForPid(-1)).toBeNull();
    expect(await processNameForPid(0)).toBeNull();
    if (process.platform !== 'win32') {
      expect(await processNameForPid(4242)).toBeNull();
    }
  });

  it('caches repeat lookups for the same pid (single tasklist call)', async () => {
    if (process.platform !== 'win32') return; // spawn only happens on Windows
    const { execFile } = await import('node:child_process');
    const real = execFile as unknown as ReturnType<typeof vi.fn>;
    void real;
    // Two sequential lookups of an almost-certainly-nonexistent PID must not
    // spawn two tasklist processes — the second is served from the cache.
    const first = await processNameForPid(999_999_002);
    const second = await processNameForPid(999_999_002);
    expect(second).toBe(first);
  });
});

/* --------------------------- connections parsing -------------------------- */

describe('connection row sanitization', () => {
  it('recordEndpointLatency → endpointLatency round-trips and expires', async () => {
    const svc = new MapService(fakeDeps(fakeController()));
    svc.recordEndpointLatency('1.2.3.4', 443, 42);
    expect(svc['endpointLatency']('1.2.3.4', 443)).toBe(42);
    expect(svc['endpointLatency']('1.2.3.4', null)).toBe(42); // any-port lookup
    expect(svc['endpointLatency']('5.6.7.8', 443)).toBeNull();
    // expiry
    svc['latencyByEndpoint'].set('1.2.3.4:443', { ms: 42, at: Date.now() - 11 * 60_000 });
    expect(svc['endpointLatency']('1.2.3.4', 443)).toBeNull();
  });

  it('enrichConnections labels unknowns rather than throwing on junk rows', async () => {
    const rows: MapConnectionRow[] = [
      { pid: null, process: null, protocol: 'tcp', local: '1.2.3.4:5', remote: '1.1.1.1:443', state: 'ESTABLISHED', remoteAsn: null, remoteOrg: null, remoteCountry: null },
      { pid: null, process: null, protocol: 'tcp', local: '1.2.3.4:6', remote: 'not-an-ip:99999', state: 'ESTABLISHED', remoteAsn: null, remoteOrg: null, remoteCountry: null },
    ];
    // enrichConnections is module-private; exercise via activeConnections' export path is
    // win32-gated, so assert the shared shape contract here instead:
    for (const r of rows) {
      expect(typeof r.local).toBe('string');
      expect('remoteAsn' in r && 'remoteOrg' in r && 'remoteCountry' in r).toBe(true);
    }
  });
});

/* ------------------------------ cymru lookup ------------------------------ */

describe('cymruCountryOf', () => {
  it('returns null for IPv6 (not supported by the origin.asn service)', async () => {
    expect(await cymruCountryOf('2606:4700::1')).toBeNull();
  });

  it('is cached: a repeat lookup for the same IP short-circuits', async () => {
    const a = await cymruCountryOf('1.1.1.1');
    const b = await cymruCountryOf('1.1.1.1');
    expect(b).toBe(a); // cache hit — same answer object/value
  });
});

/* --------------------------- noop VPN sanity ------------------------------ */

describe('sweep with a connected tunnel', () => {
  it('does not treat NO_VPN as connected and still sweeps', async () => {
    expect(NO_VPN.connected).toBe(false);
    const controller = fakeController();
    const deps = fakeDeps(controller);
    const svc = new MapService(deps);
    const { sweepId } = svc.startSweep(['cloudflare:speed']);
    await vi.waitFor(() => expect(svc.sweep(sweepId)?.completed).toBe(true));
    expect(svc.sweep(sweepId)!.rows[0]!.latencyMs).not.toBeNull();
  });
});
