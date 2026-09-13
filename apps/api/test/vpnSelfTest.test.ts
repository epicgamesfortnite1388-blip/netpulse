import { describe, expect, it, vi } from 'vitest';

import { VpnSelfTestService } from '../src/services/vpnSelfTestService';
import { VpnRegistry } from '../src/vpn/vpnService';

import type { RealtimeBus } from '../src/realtime/bus';
import type { EventService } from '../src/services/eventService';
import type { SettingsService } from '../src/services/settingsService';
import type { PlatformNetworkController } from '../src/providers/platform/types';
import type { ImportedProfile, VpnProvider, VpnStatus } from '../src/vpn/vpnService';
import type { Logger } from '../src/logger';

/* ---------------------------------------------------------------------------
 * Real entry point under test: the scheduled/manual VPN dry-run self-test.
 *
 * Contract under scrutiny:
 *  - NEVER spawns an engine process, elevates, or mutates tunnel state
 *  - honest states: ok / unavailable (environmental) / error
 *  - profile key material validated through the vault; secrets never escape
 *  - endpoint probe is SSRF-guarded and failure-tolerant (unreachable = finding)
 * ------------------------------------------------------------------------- */

function makeController(over: Partial<PlatformNetworkController> = {}): PlatformNetworkController {
  return {
    id: 'test',
    icmpPing: vi.fn(async () => ({ ok: true, ms: 1, lossPct: 0, jitterMs: 0, replies: [] })),
    tcpProbe: vi.fn(async (_host: string, port: number) => ({ ok: port === 51820, ms: port === 51820 ? 12 : null })),
    systemDnsServers: vi.fn(async () => ['1.1.1.1']),
    traceroute: vi.fn(async () => ({ hops: [] })),
    mtuProbe: vi.fn(async () => ({ ok: true, mtu: 1500, payloadSize: 1472 })),
    detectVpnBinaries: vi.fn(async () => ({ wireguard: true, openvpn: false, singbox: false })),
    ...over,
  } as PlatformNetworkController;
}

function makeProvider(over: Partial<VpnProvider> & { id: string; status: VpnStatus }): VpnProvider {
  const { status, ...rest } = over;
  return {
    init: vi.fn(async () => undefined),
    importProfile: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    status: vi.fn(async () => status),
    info: { id: over.id, name: over.id, kind: 'custom', capabilities: [], available: true },
    ...rest,
  } as unknown as VpnProvider;
}

function makeRegistry(opts: { profiles?: (ImportedProfile & { providerId: string })[]; secrets?: Record<string, string>; status?: VpnStatus } = {}): VpnRegistry {
  const registry = new VpnRegistry();
  const vaultGet = (ref: string): string | null => opts.secrets?.[ref] ?? null;
  (registry as unknown as { setVault: (v: unknown) => void }).setVault({ get: vaultGet });
  registry.register(makeProvider({ id: 'wireguard', status: opts.status ?? disconnected() }));
  for (const p of opts.profiles ?? []) registry.addProfile(p.providerId, p);
  return registry;
}

function disconnected(): VpnStatus {
  return { connected: false, serverId: null, serverName: null, protocol: null, since: null, supported: true, killSwitchActive: false, providerId: 'wireguard', verification: 'not_verified' };
}

function wgProfile(id: string, endpoint: string | null): ImportedProfile & { providerId: string } {
  return {
    id,
    name: `Profile ${id}`,
    protocol: 'wireguard',
    endpoint,
    publicKeyFingerprint: null,
    allowedIps: null,
    dns: null,
    secretRef: `wg-${id}`,
    configPath: `C:\\profiles\\${id}.conf`,
    createdAt: Date.now(),
    providerId: 'wireguard',
  };
}

const WG_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='; // valid WireGuard key shape (43 + '=')

function makeDeps(registry: VpnRegistry, controller: PlatformNetworkController) {
  const publish = vi.fn();
  const record = vi.fn();
  return {
    deps: {
      vpn: registry,
      controller,
      settings: { get: () => ({ scheduling: { vpnSelfTestEnabled: true, vpnSelfTestIntervalMin: 60 } }) } as unknown as SettingsService,
      events: { record } as unknown as EventService,
      bus: { publish } as unknown as RealtimeBus,
      log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger,
    },
    publish,
    record,
  };
}

describe('VpnSelfTestService', () => {
  it('reports ok with verified profile count when everything checks out', async () => {
    const registry = makeRegistry({
      profiles: [wgProfile('p1', '93.184.216.34:51820'), wgProfile('p2', '8.8.8.8:51820')],
      secrets: { 'wg-p1': WG_KEY, 'wg-p2': `${WG_KEY}\n${WG_KEY}` },
    });
    const { deps, record } = makeDeps(registry, makeController());

    const svc = new VpnSelfTestService(deps);
    const result = await svc.run('scheduled');

    expect(result.state).toBe('ok');
    expect(result.profilesChecked).toBe(2);
    expect(result.endpointsReachable).toBe(2);
    expect(result.engines.wireguard).toBe(true);
    expect(record).toHaveBeenCalledWith('info', 'vpn', expect.stringContaining('self-test passed'), {});
  });

  it('reports unavailable when no engine is installed (environmental, not error)', async () => {
    const registry = makeRegistry({
      profiles: [wgProfile('p1', 'vpn.example.com:51820')],
      secrets: { 'wg-p1': WG_KEY },
    });
    const controller = makeController({ detectVpnBinaries: vi.fn(async () => ({ wireguard: false, openvpn: false, singbox: false })) });
    const { deps } = makeDeps(registry, controller);

    const svc = new VpnSelfTestService(deps);
    const result = await svc.run();

    expect(result.state).toBe('unavailable');
    expect(result.detail).toMatch(/No VPN engine/i);
  });

  it('reports unavailable when engine exists but no profiles are imported', async () => {
    const registry = makeRegistry({});
    const { deps } = makeDeps(registry, makeController());

    const svc = new VpnSelfTestService(deps);
    const result = await svc.run();

    expect(result.state).toBe('unavailable');
    expect(result.detail).toMatch(/no VPN profiles/i);
  });

  it('reports error when a stored profile has missing or malformed key material', async () => {
    const registry = makeRegistry({
      profiles: [wgProfile('good', 'vpn.example.com:51820'), wgProfile('bad', 'vpn.example.com:51820')],
      secrets: { 'wg-good': WG_KEY }, // 'wg-bad' missing from vault
    });
    const { deps } = makeDeps(registry, makeController());

    const svc = new VpnSelfTestService(deps);
    const result = await svc.run();

    expect(result.state).toBe('error');
    expect(result.detail).toMatch(/1 of 2/);
    expect(result.profilesChecked).toBe(1);
  });

  it('accepts a malformed key as broken (shape validation), not ok', async () => {
    const registry = makeRegistry({
      profiles: [wgProfile('p1', 'vpn.example.com:51820')],
      secrets: { 'wg-p1': 'not-a-valid-key' },
    });
    const { deps } = makeDeps(registry, makeController());

    const svc = new VpnSelfTestService(deps);
    const result = await svc.run();

    expect(result.state).toBe('error');
    expect(result.profilesChecked).toBe(0);
  });

  it('treats an unreachable endpoint as a finding, not a crash', async () => {
    const registry = makeRegistry({
      profiles: [wgProfile('p1', '203.0.113.10:9999')], // closed port per makeController
      secrets: { 'wg-p1': WG_KEY },
    });
    const { deps } = makeDeps(registry, makeController());

    const svc = new VpnSelfTestService(deps);
    const result = await svc.run();

    expect(result.state).toBe('ok'); // keys fine; endpoint detail carries the truth
    expect(result.endpointsReachable).toBe(0);
    expect(result.detail).toMatch(/0\/1 endpoints reachable/);
  });

  it('skips the endpoint probe when a tunnel is already connected', async () => {
    const connected = { ...disconnected(), connected: true, protocol: 'wireguard' } as VpnStatus;
    const registry = makeRegistry({
      profiles: [wgProfile('p1', 'vpn.example.com:51820')],
      secrets: { 'wg-p1': WG_KEY },
      status: connected,
    });
    const tcpProbe = vi.fn(async () => ({ ok: true, ms: 5 }));
    const { deps } = makeDeps(registry, makeController({ tcpProbe }));

    const svc = new VpnSelfTestService(deps);
    const result = await svc.run();

    expect(result.state).toBe('ok');
    expect(result.detail).toMatch(/tunnel connected/);
    expect(tcpProbe).not.toHaveBeenCalled(); // dry run: never probe through the tunnel
  });

  it('refuses private/loopback endpoints via the SSRF guard (probe skipped, counted unreachable)', async () => {
    const registry = makeRegistry({
      profiles: [wgProfile('p1', '127.0.0.1:51820')],
      secrets: { 'wg-p1': WG_KEY },
    });
    const tcpProbe = vi.fn(async () => ({ ok: true, ms: 1 }));
    const { deps } = makeDeps(registry, makeController({ tcpProbe }));

    const svc = new VpnSelfTestService(deps);
    const result = await svc.run();

    expect(tcpProbe).not.toHaveBeenCalled();
    expect(result.endpointsReachable).toBe(0);
  });

  it('never spawns connect/disconnect: provider connect fns are untouched after a run', async () => {
    const connect = vi.fn();
    const disconnect = vi.fn();
    const registry = makeRegistry({
      profiles: [wgProfile('p1', 'vpn.example.com:51820')],
      secrets: { 'wg-p1': WG_KEY },
    });
    (registry.get('wireguard') as unknown as { connect: unknown; disconnect: unknown }).connect = connect;
    (registry.get('wireguard') as unknown as { connect: unknown; disconnect: unknown }).disconnect = disconnect;
    const { deps } = makeDeps(registry, makeController());

    const svc = new VpnSelfTestService(deps);
    await svc.run();

    expect(connect).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('reports error when engine detection itself fails (check could not complete)', async () => {
    const registry = makeRegistry({});
    const controller = makeController({ detectVpnBinaries: vi.fn(async () => { throw new Error('where failed'); }) });
    const { deps, record } = makeDeps(registry, controller);

    const svc = new VpnSelfTestService(deps);
    const result = await svc.run();

    expect(result.state).toBe('error');
    expect(result.detail).toMatch(/engine detection failed/);
    expect(record).toHaveBeenCalledWith('warn', 'vpn', expect.stringContaining('self-test error'), {});
  });

  it('publishes running + done on the bus topic so the UI can follow live', async () => {
    const registry = makeRegistry({
      profiles: [wgProfile('p1', 'vpn.example.com:51820')],
      secrets: { 'wg-p1': WG_KEY },
    });
    const { deps, publish } = makeDeps(registry, makeController());

    const svc = new VpnSelfTestService(deps);
    await svc.run();

    const types = publish.mock.calls.map((c) => (c[1] as { type: string }).type);
    expect(types[0]).toBe('vpn-selftest:running');
    expect(types[types.length - 1]).toBe('vpn-selftest:done');
  });
});
