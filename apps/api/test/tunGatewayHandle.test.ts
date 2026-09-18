import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The TUN gateway state machine — one owner for every engine that can take the
 * OS default route. These tests pin the three rules the two former
 * implementations had to agree on by hand:
 *
 *   1. `active` requires a verified relay, never a started process.
 *   2. A gateway whose relay check fails is STOPPED (a live device holds the
 *      default route whatever the status says).
 *   3. A device death while capturing reaches the kill-switch callback; a
 *      device WE stopped does not, because that is not a drop.
 */

const h = vi.hoisted(() => ({
  refusal: null as string | null,
  singbox: 'C:/fake/sing-box.exe' as string | null,
  startGateway: vi.fn(),
}));

vi.mock('../src/services/proxyCores', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxyCores')>();
  return {
    ...actual,
    findEngineBinary: (id: string) => (id === 'sing-box' ? h.singbox : null),
    tunGatewayStartRefusal: () => h.refusal,
    startTunGateway: (...args: unknown[]) => h.startGateway(...args),
  };
});

import { TunGatewayHandle } from '../src/services/tunGatewayHandle';

import type { TunGatewayEvent, TunGatewayOptions, TunGatewayRuntime } from '../src/services/tunGatewayHandle';

const GATEWAY_PORT = 45699;
const UPSTREAM_PORT = 45678;

/** A fake device whose close event the test can fire on demand. */
function fakeDevice() {
  const closeHandlers: Array<(code: number | null) => void> = [];
  const cleanup = vi.fn();
  return {
    cleanup,
    fireClose: (code: number | null) => {
      for (const cb of closeHandlers) cb(code);
    },
    run: {
      child: { once: (event: string, cb: (code: number | null) => void) => { closeHandlers.push(cb); } } as never,
      inboundPort: GATEWAY_PORT,
      cleanup,
      stderrTail: '',
    },
  };
}

function setup(overrides: {
  verify?: () => Promise<string | null>;
  opts?: Partial<TunGatewayOptions>;
} = {}) {
  const events: TunGatewayEvent[] = [];
  const dropped: string[] = [];
  const arm = vi.fn();
  const opts: TunGatewayOptions = {
    upstream: 'http',
    upstreamPort: () => UPSTREAM_PORT,
    label: () => 'test tunnel',
    armRouteMode: arm,
    onCapturedDrop: (reason) => dropped.push(reason),
    onState: (event) => events.push(event),
    ...overrides.opts,
  };
  const runtime: TunGatewayRuntime = {
    verifyRelay: overrides.verify ?? (async () => '206.71.158.29'),
  };
  return { handle: new TunGatewayHandle(opts, runtime), events, dropped, arm };
}

beforeEach(() => {
  h.refusal = null;
  h.singbox = 'C:/fake/sing-box.exe';
  h.startGateway.mockReset();
  h.startGateway.mockImplementation(async () => ({
    ok: true,
    gatewayPort: GATEWAY_PORT,
    run: fakeDevice().run,
  }));
});

describe('TunGatewayHandle', () => {
  it('reports the privilege gate as `admin` and never starts a device', async () => {
    h.refusal = 'TUN mode needs administrator rights to create the TUN adapter (wintun).';
    const { handle, events } = setup();
    await expect(handle.start()).resolves.toBe(false);
    expect(h.startGateway).not.toHaveBeenCalled();
    expect(handle.status()).toEqual({
      tun: null,
      tunError: h.refusal,
      tunBlockedBy: 'admin',
      tunGatewayPort: null,
    });
    expect(events.at(-1)).toEqual({ kind: 'degraded', error: h.refusal, blockedBy: 'admin' });
  });

  it('reports a missing sing-box core as `core` with the remedy', async () => {
    h.singbox = null;
    const { handle } = setup();
    await expect(handle.start()).resolves.toBe(false);
    expect(h.startGateway).not.toHaveBeenCalled();
    expect(handle.status().tunBlockedBy).toBe('core');
    expect(handle.status().tunError).toMatch(/install it on the sing-box tab/);
  });

  it('reports nothing to front as `relay` instead of starting a device blindly', async () => {
    const { handle } = setup({ opts: { upstreamPort: () => null } });
    await expect(handle.start()).resolves.toBe(false);
    expect(h.startGateway).not.toHaveBeenCalled();
    expect(handle.status().tunBlockedBy).toBe('relay');
    expect(handle.status().tunError).toMatch(/no inbound port/);
  });

  it('hands the caller-owned wiring to the gateway (protocol, exclusions, bypass)', async () => {
    const { handle } = setup({
      opts: { upstream: 'socks', excludeAddresses: async () => ['199.232.78.159/32'] },
    });
    await handle.start();
    const args = h.startGateway.mock.calls[0] ?? [];
    expect(args[0]).toBe('C:/fake/sing-box.exe');
    expect(args[1]).toBe(UPSTREAM_PORT);
    expect(args[4]).toBe('socks');
    expect(args[5]).toEqual(['199.232.78.159/32']);
  });

  it('is `active` only after a verified relay, and arms route mode then', async () => {
    const { handle, events, arm } = setup();
    await expect(handle.start()).resolves.toBe(true);
    expect(handle.active).toBe(true);
    expect(handle.status()).toEqual({
      tun: 'active',
      tunError: null,
      tunBlockedBy: null,
      tunGatewayPort: GATEWAY_PORT,
    });
    expect(arm).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.kind)).toEqual(['requested', 'active']);
    expect(events[1]).toEqual({ kind: 'active', exitIp: '206.71.158.29', gatewayPort: GATEWAY_PORT });
  });

  it('STOPS a gateway whose relay check fails, and says so', async () => {
    const device = fakeDevice();
    h.startGateway.mockImplementation(async () => ({ ok: true, gatewayPort: GATEWAY_PORT, run: device.run }));
    const { handle, events, arm, dropped } = setup({
      verify: async () => { throw new Error('TLS handshake through proxy timed out'); },
    });

    await expect(handle.start()).resolves.toBe(false);
    expect(device.cleanup).toHaveBeenCalledTimes(1);
    const status = handle.status();
    expect(status.tun).toBeNull();
    expect(status.tunGatewayPort).toBeNull();
    expect(status.tunBlockedBy).toBe('relay');
    expect(status.tunError).toMatch(/did not relay/);
    expect(status.tunError).toMatch(/stopped/);
    // Nothing armed a route-mode hold, and no drop was reported for a device we
    // killed ourselves.
    expect(arm).not.toHaveBeenCalled();
    expect(dropped).toEqual([]);
    expect(events.some((e) => e.kind === 'active')).toBe(false);
  });

  it('treats a reply with no exit address as a failed relay, not an unclear success', async () => {
    const device = fakeDevice();
    h.startGateway.mockImplementation(async () => ({ ok: true, gatewayPort: GATEWAY_PORT, run: device.run }));
    const { handle } = setup({ verify: async () => null });
    await expect(handle.start()).resolves.toBe(false);
    expect(device.cleanup).toHaveBeenCalledTimes(1);
    expect(handle.status().tunError).toMatch(/did not contain an ip= line/);
    expect(handle.status().tunError).toMatch(/stopped/);
  });

  it('reports a gateway start failure as `relay` without inventing a device', async () => {
    h.startGateway.mockImplementation(async () => ({ ok: false, error: 'TUN gateway did not become ready in 12000ms' }));
    const { handle } = setup();
    await expect(handle.start()).resolves.toBe(false);
    expect(handle.status().tunBlockedBy).toBe('relay');
    expect(handle.status().tunError).toBe('TUN gateway did not become ready in 12000ms');
  });

  it('hands a device death to the drop callback, and withdraws capture', async () => {
    const device = fakeDevice();
    h.startGateway.mockImplementation(async () => ({ ok: true, gatewayPort: GATEWAY_PORT, run: device.run }));
    const { handle, events, dropped } = setup();
    await handle.start();

    device.fireClose(7);

    expect(handle.status()).toEqual({
      tun: null,
      tunError: 'TUN gateway exited unexpectedly (code 7)',
      tunBlockedBy: null,
      tunGatewayPort: null,
    });
    expect(dropped).toEqual(['TUN gateway exited unexpectedly (code 7)']);
    const last = events.at(-1);
    expect(last).toEqual({ kind: 'degraded', error: 'TUN gateway exited unexpectedly (code 7)' });
    // A lost capture reports no cause it did not diagnose.
    expect(last && 'blockedBy' in last ? last.blockedBy : undefined).toBeUndefined();
    expect(device.cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not report a drop for a device it stopped itself', async () => {
    const device = fakeDevice();
    h.startGateway.mockImplementation(async () => ({ ok: true, gatewayPort: GATEWAY_PORT, run: device.run }));
    const { handle, events, dropped } = setup();
    await handle.start();

    handle.stop();
    expect(device.cleanup).toHaveBeenCalledTimes(1);
    expect(handle.status().tun).toBeNull();

    device.fireClose(0); // the kernel/OS closes it a moment later
    expect(dropped).toEqual([]);
    expect(events.at(-1)?.kind).toBe('active'); // no degraded event was added
  });

  it('keeps one device at a time: a restart tears the previous one down first', async () => {
    const first = fakeDevice();
    const second = fakeDevice();
    h.startGateway
      .mockImplementationOnce(async () => ({ ok: true, gatewayPort: GATEWAY_PORT, run: first.run }))
      .mockImplementationOnce(async () => ({ ok: true, gatewayPort: GATEWAY_PORT + 1, run: second.run }));
    const { handle, dropped } = setup();

    await handle.start();
    await handle.start();

    expect(first.cleanup).toHaveBeenCalledTimes(1);
    expect(handle.status().tunGatewayPort).toBe(GATEWAY_PORT + 1);
    // The replaced device's exit belongs to the deliberate teardown.
    first.fireClose(1);
    expect(dropped).toEqual([]);
    expect(handle.active).toBe(true);
  });

  it('stops being active when the relay proof is gone but never claims a cause', async () => {
    const device = fakeDevice();
    h.startGateway.mockImplementation(async () => ({ ok: true, gatewayPort: GATEWAY_PORT, run: device.run }));
    const { handle } = setup();
    await handle.start();
    device.fireClose(null);
    expect(handle.active).toBe(false);
    expect(handle.status().tunError).toMatch(/code \?/);
  });
});
