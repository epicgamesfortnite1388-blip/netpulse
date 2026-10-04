import { beforeEach, describe, expect, it, vi } from 'vitest';

import { waitForSignal } from './helpers/waitForSignal';

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
 *   4. A verified capture whose kill-switch hold could NOT be armed is
 *      `unguarded`, never `active`: the device stays up (traffic really is
 *      flowing through it), but the status must not promise the guarantee the
 *      machine does not have.
 */

const h = vi.hoisted(() => ({
  refusal: null as string | null,
  singbox: 'C:/fake/sing-box.exe' as string | null,
  startGateway: vi.fn(),
  /** Every fake device the mocked gateway hands out, in start order. */
  devices: [] as Array<{ fireClose: (code: number | null) => void; cleanup: () => void }>,
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
import { tunGatewayRemedy } from '../src/util/privileges';

import type { TunGatewayEvent, TunGatewayOptions, TunGatewayRuntime } from '../src/services/tunGatewayHandle';
import type { TunSweepSummary } from '../src/services/tunClaim';

/** A sweep that found nothing — the pre-flight's benign default for tests. */
const CLEAN_SWEEP: TunSweepSummary = { reaped: 0, litter: 0, alive: 0, refused: 0, refusals: [] };

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
  /** The route-claim pre-flight. Defaults to "nothing stranded". */
  sweep?: () => Promise<TunSweepSummary>;
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
    sweepRouteClaims: overrides.sweep ?? (async () => CLEAN_SWEEP),
  };
  return { handle: new TunGatewayHandle(opts, runtime), events, dropped, arm };
}

beforeEach(() => {
  h.refusal = null;
  h.singbox = 'C:/fake/sing-box.exe';
  h.devices = [];
  h.startGateway.mockReset();
  h.startGateway.mockImplementation(async () => {
    const device = fakeDevice();
    h.devices.push(device);
    return { ok: true, gatewayPort: GATEWAY_PORT, run: device.run };
  });
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
      tunWatchdog: { rearming: false, autoAttempts: 0, maxAutoAttempts: 1, lastError: null },
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

  it('refuses to put a device on top of a stranded route, naming the reason and the remedy', async () => {
    const reason =
      'gateway pid 42 is running but its command line cannot be verified from here — run the app as administrator to release the route';
    const { handle, events } = setup({
      sweep: async () => ({ reaped: 0, litter: 0, alive: 0, refused: 1, refusals: [{ dir: 'C:/tmp/netpulse-tun-gw-x', reason }] }),
    });

    await expect(handle.start()).resolves.toBe(false);

    // Nothing was created over the stranded route, and the refusal is its own
    // cause — not the generic "needs administrator rights" one.
    expect(h.startGateway).not.toHaveBeenCalled();
    const status = handle.status();
    expect(status.tun).toBeNull();
    expect(status.tunBlockedBy).toBe('stranded-route');
    // The consequence is the caller's to state: the sweep reports what it
    // found, the handle says the device was not put on top of it.
    expect(status.tunError).toContain('TUN was not started');
    expect(status.tunError).toContain('cannot be verified');
    // The action comes from the privilege matrix's own remedy; a test process
    // that already runs elevated has no remedy to offer (the route would have
    // been released, not refused).
    const remedy = tunGatewayRemedy();
    if (remedy) expect(status.tunError).toContain(remedy);
    expect(events.map((e) => e.kind)).toEqual(['requested', 'degraded']);
    expect(events.at(-1)).toMatchObject({ kind: 'degraded', blockedBy: 'stranded-route' });
  });

  it('runs the pre-flight on every manual start — the retry that releases the route when it can', async () => {
    const sweep = vi.fn(async () => ({ reaped: 1, litter: 0, alive: 0, refused: 0, refusals: [] }));
    const { handle } = setup({ sweep });

    // A reap is not a blocker: the route is released, then the device starts.
    await expect(handle.start()).resolves.toBe(true);
    await handle.stop();
    await expect(handle.start()).resolves.toBe(true);

    expect(sweep).toHaveBeenCalledTimes(2);
    expect(h.startGateway).toHaveBeenCalledTimes(2);
  });

  it('does not re-sweep on a watchdog re-arm (boot and manual starts covered it)', async () => {
    const sweep = vi.fn(async () => CLEAN_SWEEP);
    const { handle } = setup({ sweep });
    await handle.start();
    expect(sweep).toHaveBeenCalledTimes(1);

    h.devices[0]!.fireClose(9);
    await waitForSignal(() => expect(h.devices).toHaveLength(2));

    expect(h.startGateway).toHaveBeenCalledTimes(2);
    expect(sweep).toHaveBeenCalledTimes(1);
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
      tunWatchdog: { rearming: false, autoAttempts: 0, maxAutoAttempts: 1, lastError: null },
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

  it('reports `unguarded` when the hold refuses to arm, and keeps the capture up', async () => {
    const device = fakeDevice();
    h.startGateway.mockImplementation(async () => ({ ok: true, gatewayPort: GATEWAY_PORT, run: device.run }));
    const { handle, events } = setup({
      opts: { armRouteMode: () => 'the kill switch is on, but no kill-switch service is wired into this tunnel' },
    });

    // Still a capture: traffic IS flowing, so the caller must not be told the
    // start failed and must not tear the engine down.
    await expect(handle.start()).resolves.toBe(true);
    expect(device.cleanup).not.toHaveBeenCalled();
    expect(handle.status()).toEqual({
      tun: 'unguarded',
      tunError:
        'TUN is capturing but the kill-switch hold could not be armed: the kill switch is on, but no kill-switch service is wired into this tunnel — a drop now falls back to the direct path instead of blocking',
      tunBlockedBy: 'kill-switch',
      tunGatewayPort: GATEWAY_PORT,
      tunWatchdog: { rearming: false, autoAttempts: 0, maxAutoAttempts: 1, lastError: null },
    });
    // `active` is what other code branches on; an unarmed hold must not set it.
    expect(handle.active).toBe(false);
    expect(events.map((e) => e.kind)).toEqual(['requested', 'unguarded']);
    expect(events.some((e) => e.kind === 'active')).toBe(false);
    expect(events.at(-1)).toEqual({
      kind: 'unguarded',
      error: expect.stringMatching(/could not be armed/),
    });
  });

  it('treats a plain refusal and a thrown arm error as the same unguarded state', async () => {
    for (const armRouteMode of [
      () => false as const,
      () => {
        throw new Error('kill-switch hold could not be persisted: EACCES');
      },
    ]) {
      const device = fakeDevice();
      h.startGateway.mockImplementation(async () => ({ ok: true, gatewayPort: GATEWAY_PORT, run: device.run }));
      const { handle } = setup({ opts: { armRouteMode } });

      await expect(handle.start()).resolves.toBe(true);
      expect(device.cleanup).not.toHaveBeenCalled();
      expect(handle.status().tun).toBe('unguarded');
      expect(handle.status().tunBlockedBy).toBe('kill-switch');
    }
  });

  it('carries the real reason when the hold throws, without inventing one', async () => {
    const device = fakeDevice();
    h.startGateway.mockImplementation(async () => ({ ok: true, gatewayPort: GATEWAY_PORT, run: device.run }));
    const { handle } = setup({
      opts: {
        armRouteMode: () => {
          throw new Error('kill-switch hold could not be persisted: EACCES');
        },
      },
    });
    await handle.start();
    expect(handle.status().tunError).toContain('EACCES');
    expect(handle.status().tunError).toMatch(/falls back to the direct path/);
  });

  it('still reports a drop when an unguarded capture dies', async () => {
    // Self-healing off: this is the drop contract itself, unchanged.
    const { handle, dropped } = setup({ opts: { armRouteMode: () => 'no hold', watchdog: null } });
    await handle.start();

    h.devices[0]!.fireClose(3);

    // The kill switch decides what happens (and, having no hold, will not
    // block) — but the transition is still reported, never silently swallowed.
    expect(dropped).toEqual(['TUN gateway exited unexpectedly (code 3)']);
    expect(handle.status().tun).toBeNull();
  });

  it('hands a device death to the drop callback, and withdraws capture (watchdog off)', async () => {
    const { handle, events, dropped } = setup({ opts: { watchdog: null } });
    await handle.start();

    h.devices[0]!.fireClose(7);

    expect(handle.status()).toEqual({
      tun: null,
      tunError: 'TUN gateway exited unexpectedly (code 7)',
      tunBlockedBy: null,
      tunGatewayPort: null,
      tunWatchdog: { rearming: false, autoAttempts: 0, maxAutoAttempts: 0, lastError: null },
    });
    expect(dropped).toEqual(['TUN gateway exited unexpectedly (code 7)']);
    // The loss is announced before any handoff work, so nothing keeps claiming
    // capture while the drop is being handled.
    expect(events.at(-1)).toEqual({ kind: 'dropped', error: 'TUN gateway exited unexpectedly (code 7)' });
    const last = await theDegradedEvent(events);
    expect(last).toEqual({ kind: 'degraded', error: 'TUN gateway exited unexpectedly (code 7)' });
    // A lost capture reports no cause it did not diagnose.
    expect(last && 'blockedBy' in last ? last.blockedBy : undefined).toBeUndefined();
    expect(h.devices[0]!.cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not report a drop for a device it stopped itself', async () => {
    const { handle, events, dropped } = setup();
    await handle.start();

    handle.stop();
    expect(h.devices[0]!.cleanup).toHaveBeenCalledTimes(1);
    expect(handle.status().tun).toBeNull();

    h.devices[0]!.fireClose(0); // the kernel/OS closes it a moment later
    expect(dropped).toEqual([]);
    expect(events.at(-1)?.kind).toBe('active'); // no degraded event was added
    expect(h.startGateway).toHaveBeenCalledTimes(1); // and nothing was re-armed
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
    const { handle } = setup({ opts: { watchdog: null } });
    await handle.start();
    h.devices[0]!.fireClose(null);
    expect(handle.active).toBe(false);
    expect(handle.status().tunError).toMatch(/code \?/);
  });
});

describe('TunGatewayHandle self-healing watchdog', () => {
  /**
   * The watchdog contract: a dropped capture is healed ONCE, the drop is still
   * handed to the kill switch first (fail closed), nothing is ever claimed as
   * captured while it is being re-established, and a failed or flapping attempt
   * ends with the drop standing — never with a respawn loop.
   */

  it('heals a dropped capture with one automatic re-arm, reporting `recovering` while it tries', async () => {
    // Hold the re-arm's relay proof open so the in-flight state is observable.
    let releaseVerify: (() => void) | null = null;
    const verify = vi.fn(async () => {
      if (h.devices.length === 2) await new Promise<void>((resolve) => { releaseVerify = resolve; });
      return '206.71.158.29';
    });
    const { handle, events, dropped } = setup({ verify });
    await handle.start();
    const first = h.devices[0]!;

    first.fireClose(9);
    // The drop reaches the kill switch BEFORE anything is healed.
    await waitForSignal(() => expect(h.devices).toHaveLength(2));

    expect(dropped).toEqual(['TUN gateway exited unexpectedly (code 9)']);
    const mid = handle.status();
    expect(mid.tun).toBe('recovering'); // never `active` while nothing is captured
    expect(mid.tunError).toBe('TUN gateway exited unexpectedly (code 9)');
    expect(mid.tunWatchdog).toMatchObject({ rearming: true, autoAttempts: 1, maxAutoAttempts: 1 });
    expect(handle.active).toBe(false);
    // The re-arm does not get the long manual budget: a user is already living
    // on this capture, so it is bounded tighter.
    expect(h.startGateway.mock.calls[1]?.[3]).toBe(8_000);

    releaseVerify?.();
    await verifyDone(events);

    const healed = handle.status();
    expect(healed.tun).toBe('active');
    expect(healed.tunError).toBeNull();
    expect(healed.tunWatchdog).toMatchObject({ rearming: false, autoAttempts: 1, lastError: null });
    expect(handle.active).toBe(true);
    expect(events.map((e) => e.kind)).toEqual(['requested', 'active', 'dropped', 'recovering', 'recovered']);
    expect(events.at(-1)).toMatchObject({ kind: 'recovered', attempt: 1 });
  });

  it('gives up honestly when the re-arm does not restore capture', async () => {
    const { handle, events, dropped } = setup();
    await handle.start();
    h.startGateway.mockImplementation(async () => ({ ok: false, error: 'TUN gateway did not become ready in 8000ms' }));

    h.devices[0]!.fireClose(9);
    await waitForSignal(() => expect(handle.status().tunError).toMatch(/automatic re-arm/));

    const status = handle.status();
    expect(status.tun).toBeNull(); // the drop stands
    expect(status.tunBlockedBy).toBe('relay');
    expect(status.tunError).toContain('TUN capture was lost');
    expect(status.tunError).toContain('did not become ready in 8000ms');
    expect(status.tunWatchdog).toMatchObject({ rearming: false, autoAttempts: 1, lastError: expect.stringContaining('did not become ready') });
    // The loss was reported to the kill switch exactly once, and the failed
    // attempt is not repeated.
    expect(dropped).toHaveLength(1);
    expect(h.startGateway).toHaveBeenCalledTimes(2);
    expect(events.map((e) => e.kind)).toEqual(['requested', 'active', 'dropped', 'recovering', 'degraded']);
  });

  it('does not re-arm a second time when the healed capture dies again', async () => {
    const { handle, events, dropped } = setup();
    await handle.start();

    h.devices[0]!.fireClose(1);
    await waitForSignal(() => expect(handle.status().tun).toBe('active'));
    expect(h.devices).toHaveLength(2);

    // A flapping gateway gets its one attempt and no more.
    h.devices[1]!.fireClose(1);
    await theDegradedEvent(events);

    expect(handle.status().tun).toBeNull();
    expect(h.startGateway).toHaveBeenCalledTimes(2);
    expect(dropped).toHaveLength(2);
    expect(events.map((e) => e.kind)).toEqual([
      'requested',
      'active',
      'dropped',
      'recovering',
      'recovered',
      'dropped',
      'degraded',
    ]);
  });

  it('refills the budget once a capture has held long enough to count as healthy', async () => {
    const { handle } = setup({ opts: { watchdog: { healthyMs: 0 } } });
    await handle.start();

    h.devices[0]!.fireClose(1);
    await waitForSignal(() => expect(handle.status().tun).toBe('active'));
    h.devices[1]!.fireClose(1); // long enough by this policy
    await waitForSignal(() => expect(h.devices).toHaveLength(3));

    expect(h.startGateway).toHaveBeenCalledTimes(3);
    await waitForSignal(() => expect(handle.status().tun).toBe('active'));
  });

  it('abandons the re-arm when the user stops the tunnel while the drop is being handled', async () => {
    // The drop notification is what the watchdog waits on first (fail closed
    // BEFORE healing): hold it open, stop the tunnel, then let it finish. A
    // stop is the user's truth and must win over a heal in flight.
    let releaseDrop: (() => void) | null = null;
    const { handle, dropped } = setup({
      opts: {
        onCapturedDrop: async (reason) => {
          dropped.push(reason);
          await new Promise<void>((resolve) => { releaseDrop = resolve; });
        },
      },
    });
    await handle.start();

    h.devices[0]!.fireClose(2);
    await waitForSignal(() => expect(releaseDrop).not.toBeNull());
    handle.stop();
    releaseDrop!();
    await new Promise((r) => setTimeout(r, 20));

    expect(h.startGateway).toHaveBeenCalledTimes(1); // nothing was re-armed
    expect(handle.status().tun).toBeNull();
    expect(handle.active).toBe(false);
  });

  it('bounds the re-arm’s relay proof so it cannot hang in `recovering`', async () => {
    const verify = vi.fn(async () => {
      if (h.devices.length === 2) await new Promise<void>(() => undefined); // never settles
      return '206.71.158.29';
    });
    const { handle } = setup({ verify, opts: { watchdog: { rearmDeadlineMs: 60 } } });
    await handle.start();

    h.devices[0]!.fireClose(1);
    await waitForSignal(() => expect(handle.status().tunError).toMatch(/no relay proof within 60ms/));

    const status = handle.status();
    expect(status.tun).toBeNull();
    expect(status.tunBlockedBy).toBe('relay');
    expect(status.tunWatchdog.rearming).toBe(false);
    // Rule 2 still applies to a re-armed device: it is stopped, not left owning
    // the default route on an unproven path.
    expect(h.devices[1]!.cleanup).toHaveBeenCalledTimes(1);
  });
});

/** Wait until the watchdog has reported the healed capture. */
async function verifyDone(events: TunGatewayEvent[]): Promise<void> {
  await waitForSignal(() => expect(events.at(-1)?.kind).toBe('recovered'));
}

/**
 * Wait for the drop to be reported as standing. The death path notifies the
 * kill switch first (fail closed) before it concludes anything, so the event is
 * asynchronous by design.
 */
async function theDegradedEvent(events: TunGatewayEvent[]): Promise<TunGatewayEvent | undefined> {
  await waitForSignal(() => expect(events.at(-1)?.kind).toBe('degraded'));
  return events.at(-1);
}
