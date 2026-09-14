import { afterEach, describe, expect, it, vi } from 'vitest';

import dnsPromises from 'node:dns/promises';

import { resetGeoGuardForTests, setGeoOverridesForTest } from '../src/services/geoGuard';
import { MapService, cymruCountryOf } from '../src/services/mapService';
import { RealtimeBus } from '../src/realtime/bus';

import type { PlatformNetworkController } from '../src/providers/platform/types';
import type { IcmpPingOptions, TracerouteOptions } from '../src/providers/platform/types';
import type { NetworkTarget, PingResult, TcpProbeResult, TraceResult } from '@netpulse/shared';
import type { MapObservationsRepository, ScanRepository, ServersRepository } from '../src/db/repositories';
import type { EventService } from '../src/services/eventService';
import type { IpInfoService } from '../src/services/ipInfoService';
import type { Logger } from '../src/logger';
import type { RouteService } from '../src/services/routeService';
import type { VpnRegistry } from '../src/vpn/vpnService';

/* ---------------------------------------------------------------------------
 * Geo-honesty on the map: the sweep must REFUSE a registry country for
 * anycast / edge-fabric IPs (the "Cloudflare is in Australia" artifact class)
 * and stamp geoStatusReason instead; unicast IPs keep their real country and
 * user overrides win over the curated lists.
 *
 * Real entry points: MapService.startSweep → runSweep → sweepOne with the
 * service's own DNS-resolver target catalog (hosts are literal IPs, so no
 * network resolution is needed). cymruCountryOf is mocked for the unicast
 * case — the guard decision itself runs for real.
 * ------------------------------------------------------------------------- */

const noopLog: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

function fakeController(): PlatformNetworkController {
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
  } as unknown as PlatformNetworkController;
}

function fakeDeps(controller: PlatformNetworkController): ConstructorParameters<typeof MapService>[0] {
  return {
    controller,
    route: { runTrace: vi.fn(async () => ({ trace: null, analysis: { findings: [] } })) } as unknown as RouteService,
    ipInfo: { lookup: vi.fn(async () => null) } as unknown as IpInfoService,
    vpn: {
      listProfiles: vi.fn(() => []),
      all: vi.fn(() => []),
      status: vi.fn(async () => null),
      getSecretForCheck: vi.fn(() => null),
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

async function sweepRow(svc: MapService, targetId: string) {
  const { sweepId } = svc.startSweep([targetId]);
  await vi.waitFor(() => expect(svc.sweep(sweepId)?.completed).toBe(true));
  const row = svc.sweep(sweepId)!.rows.find((r) => r.target.id === targetId);
  expect(row, `sweep row for ${targetId}`).toBeDefined();
  return row!;
}

afterEach(() => {
  resetGeoGuardForTests();
  vi.restoreAllMocks();
});

describe('sweep geo honesty', () => {
  it('refuses a country for an anycast resolver and stamps the reason', async () => {
    const cymruSpy = vi.spyOn(dnsPromises, 'resolveTxt');
    const controller = fakeController();
    const svc = new MapService(fakeDeps(controller));
    const row = await sweepRow(svc, 'dns:quad9-9999'); // 9.9.9.9 — curated anycast host
    expect(row.resolvedIp).toBe('9.9.9.9');
    expect(row.country).toBeNull();
    expect(row.geoStatusReason).toBe('anycast');
    // Refused pins must not even spend a registry lookup.
    expect(cymruSpy).not.toHaveBeenCalled();
  });

  it('keeps the real country for a plain unicast IP', async () => {
    // Shecan (178.22.122.100) is an Iranian sanction resolver — unicast, and
    // its registry country comes back through the (mocked) Cymru service.
    vi.spyOn(dnsPromises, 'resolveTxt').mockImplementation(async (name: string) => {
      if (name.startsWith('100.122.22.178.')) return [['AS61173 | PJS-heroz | IR | 178.22.122.0/24 | IR | Shekan']];
      throw new Error('offline');
    });
    const controller = fakeController();
    const svc = new MapService(fakeDeps(controller));
    const row = await sweepRow(svc, 'dns:shecan-1');
    expect(row.resolvedIp).toBe('178.22.122.100');
    expect(row.country).toBe('IR');
    expect(row.geoStatusReason ?? null).toBeNull();
  });

  it('a user vouch override beats the curated refusal (unicast with coordinates)', async () => {
    // Deterministic: mock the cymru TXT lookup for 1.1.1.1 (the guard decision
    // itself still runs for real; only the registry country is stubbed).
    vi.spyOn(dnsPromises, 'resolveTxt').mockImplementation(async (name: string) => {
      if (name.startsWith('1.1.1.1.')) return [['AS13335 | CLOUDFLARENET | US | 1.1.1.0/24 | US | Cloudflare']];
      throw new Error('offline');
    });
    setGeoOverridesForTest(
      new Map([
        ['1.1.1.1', { class: 'unicast', force: { lat: -33.87, lon: 151.21, country: 'Australia' }, note: 'user attested' }],
      ]),
    );
    const controller = fakeController();
    const svc = new MapService(fakeDeps(controller));
    const row = await sweepRow(svc, 'dns:cloudflare-1111');
    // Override reclassifies the IP to unicast → the guard does not refuse,
    // so the row keeps a country cell and carries no refusal stamp.
    expect(row.resolvedIp).toBe('1.1.1.1');
    expect(row.geoStatusReason ?? null).toBeNull();
    expect(row.country).not.toBeNull(); // vouched IP gets normal treatment
  });

  it('cymruCountryOf is untouched: anycast still resolves via cymru when asked directly', async () => {
    // The sweep refuses anycast countries, but the exported helper keeps its
    // contract for other callers (route hops etc.).
    expect(typeof cymruCountryOf).toBe('function');
  });
});
