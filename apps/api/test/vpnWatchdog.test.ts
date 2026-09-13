import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VpnDropWatchdog } from '../src/vpn/vpnWatchdog';
import { VpnRegistry } from '../src/vpn/vpnService';

import type { VpnProvider, VpnStatus } from '../src/vpn/vpnService';

function statusOf(connected: boolean, serverId: string | null = null): VpnStatus {
  return { connected, serverId, serverName: serverId, protocol: 'wireguard', since: null, supported: true, killSwitchActive: false, providerId: 'wireguard' };
}

function makeProvider(behaviour: { connected: boolean; connectShould?: 'succeed' | 'fail' }): VpnProvider & { connectCalls: number } {
  const provider = {
    info: { id: 'wireguard', name: 'WireGuard', kind: 'wireguard', capabilities: ['connect'], available: true },
    connectCalls: 0,
    async init() {},
    async importProfile(): Promise<never> { throw new Error('unused'); },
    async connect() {
      provider.connectCalls += 1;
      if (behaviour.connectShould === 'fail') throw new Error('tunnel refused');
      behaviour.connected = true;
      return statusOf(true, 'p1');
    },
    async disconnect() {
      behaviour.connected = false;
      return statusOf(false);
    },
    async status() {
      return statusOf(behaviour.connected, behaviour.connected ? 'p1' : null);
    },
  } as unknown as VpnProvider & { connectCalls: number };
  return provider;
}

function makeRegistry(provider: VpnProvider): VpnRegistry {
  const reg = new VpnRegistry();
  reg.register(provider);
  reg.addProfile('wireguard', {
    id: 'p1', name: 'Profile One', protocol: 'wireguard', endpoint: '203.0.113.10:51820',
    publicKeyFingerprint: null, allowedIps: null, dns: null, secretRef: 'wg-p1', configPath: '/x', createdAt: Date.now(),
  });
  return reg;
}

describe('VpnDropWatchdog (process-killed mid-session supervision)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('detects a tunnel disappearance and reconnects (bounded, in order)', async () => {
    const behaviour = { connected: true, connectShould: 'succeed' as const };
    const provider = makeProvider(behaviour);
    const reg = makeRegistry(provider);
    const events: string[] = [];
    const published: string[] = [];
    const wd = new VpnDropWatchdog(reg, {
      event: (level, msg) => events.push(`${level}:${msg}`),
      bus: { publish: (_t, m) => published.push(m.type) } as never,
    });
    wd.start();

    // tick 1: tunnel up -> remembered
    await vi.advanceTimersByTimeAsync(10_000);
    expect(provider.connectCalls).toBe(0);

    // the engine process was killed externally: status now reports down
    behaviour.connected = false;
    await vi.advanceTimersByTimeAsync(10_000); // tick 2: drop detected
    await vi.advanceTimersByTimeAsync(5_000 + 10_000 + 20_000 + 5_000); // reconnect chain incl. backoff

    expect(events.some((e) => e.startsWith('warn:') && e.includes('dropped'))).toBe(true);
    expect(provider.connectCalls).toBe(1);
    expect(published).toContain('vpn:dropped');
    expect(published).toContain('vpn:reconnected');
    expect(published).not.toContain('vpn:reconnect_gave_up');
    wd.stop();
  });

  it('gives up after the bounded attempts and publishes reconnect_gave_up', async () => {
    const behaviour = { connected: false, connectShould: 'fail' as const };
    const provider = makeProvider(behaviour);
    const reg = makeRegistry(provider);
    const published: string[] = [];
    const events: string[] = [];
    const wd = new VpnDropWatchdog(reg, {
      event: (level, msg) => events.push(`${level}:${msg}`),
      bus: { publish: (_t, m) => published.push(m.type) } as never,
    });
    // remember a connection without a prior up-tick
    (wd as unknown as { lastConnectedProfileId: string }).lastConnectedProfileId = 'p1';
    (wd as unknown as { lastConnectedProviderId: string }).lastConnectedProviderId = 'wireguard';
    wd.start();

    await vi.advanceTimersByTimeAsync(10_000 + 5_000 + 10_000 + 20_000 + 5_000);

    expect(provider.connectCalls).toBe(3); // bounded: exactly RECONNECT_DELAYS_MS.length
    expect(published).toContain('vpn:reconnect_gave_up');
    expect(events.some((e) => e.startsWith('error:') && e.includes('attempt 3/3'))).toBe(true);
    // and it does NOT loop afterwards
    await vi.advanceTimersByTimeAsync(60_000);
    expect(provider.connectCalls).toBe(3);
    wd.stop();
  });

  it('never reconnects after an explicit user disconnect', async () => {
    const behaviour = { connected: true, connectShould: 'succeed' as const };
    const provider = makeProvider(behaviour);
    const reg = makeRegistry(provider);
    const wd = new VpnDropWatchdog(reg, {});
    wd.start();
    await vi.advanceTimersByTimeAsync(10_000); // tunnel up, remembered

    behaviour.connected = false;
    wd.acknowledgeUserDisconnect();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(provider.connectCalls).toBe(0);
    wd.stop();
  });

  it('survives status probes throwing (engine gone entirely)', async () => {
    const failing = {
      info: { id: 'wireguard', name: 'WireGuard', kind: 'wireguard', capabilities: [], available: false },
      async init() {},
      async status(): Promise<VpnStatus> { throw new Error('wg binary vanished'); },
      async connect(): Promise<VpnStatus> { throw new Error('no'); },
      async importProfile(): Promise<never> { throw new Error('unused'); },
      async disconnect() { return statusOf(false); },
    } as unknown as VpnProvider;
    const reg = new VpnRegistry();
    reg.register(failing);
    const wd = new VpnDropWatchdog(reg, {});
    wd.start();
    await expect(vi.advanceTimersByTimeAsync(30_000)).resolves.not.toThrow();
    wd.stop();
  });
});
