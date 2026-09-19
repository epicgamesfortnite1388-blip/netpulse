import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TUN mode against the machine, not the mock: the gateway is a real sing-box
 * process whose TUN device takes the DEFAULT ROUTE. Two contracts follow from
 * that, both found the hard way on a live machine:
 *
 *  1. The hop's own address must be excluded from that route. Otherwise the
 *     hop's dial to the node is captured by the device, handed back to the
 *     gateway, and forwarded to the hop again — relay never happens, and the
 *     machine simultaneously loses DNS and connectivity.
 *  2. A gateway whose relay check fails must be STOPPED. A live device holds
 *     the default route regardless of what the status reports, so leaving it
 *     running is a blackhole with an honest-looking status attached.
 */

const h = vi.hoisted(() => ({
  startTunGateway: vi.fn(),
  cleanup: vi.fn(),
  /** 'close' listeners of the fake gateway process, so a test can kill it. */
  closes: [] as Array<(code: number | null) => void>,
}));

vi.mock('../src/services/proxyCores', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxyCores')>();
  return {
    ...actual,
    findEngineBinary: (id: string) => (id === 'sing-box' ? 'C:/fake/sing-box.exe' : null),
    tunGatewayStartRefusal: () => null, // pretend the sidecar is elevated
    startTunGateway: (...args: unknown[]) => h.startTunGateway(...args),
  };
});

import { ProxyTunnelService } from '../src/services/proxyTunnel';

import type { TunnelDeps, TunnelNodeInput } from '../src/services/proxyTunnel';

const HOP_PORT = 45678;
const GATEWAY_PORT = 45699;
const NODE_HOST = '199.232.78.159';

function node(overrides: Partial<TunnelNodeInput> = {}): TunnelNodeInput {
  return {
    id: 'n1',
    protocol: 'vless',
    host: NODE_HOST,
    port: 443,
    transport: 'tcp',
    security: 'tls',
    sni: null,
    alpn: null,
    fingerprint: null,
    flow: null,
    alterId: null,
    path: null,
    hostHeader: null,
    serviceName: null,
    allowInsecure: null,
    encryption: null,
    ssrProtocol: null,
    realityPublicKey: null,
    realityShortId: null,
    realityServerName: null,
    remark: null,
    ...overrides,
  };
}

function makeDeps(trace: (port: number) => Promise<string>, arm = vi.fn(), onDropped = vi.fn()) {
  const events: string[] = [];
  let systemProxy: string | null = null;
  const deps: TunnelDeps = {
    nodeVault: null,
    fetchThroughPort: (port) => trace(port),
    setSystemProxy: async (p) => { systemProxy = p; return { ok: true }; },
    getSystemProxy: async () => ({ proxy: systemProxy }),
    publish: (kind, payload) => events.push(`${kind}:${JSON.stringify(payload)}`),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    findBinary: () => '/fake/xray.exe',
    startCoreFn: async () => ({
      ok: true,
      run: {
        child: { once: () => undefined, kill: () => true } as never,
        inboundPort: HOP_PORT,
        cleanup: () => undefined,
        stderrTail: '',
      },
    }),
    killSwitch: {
      arm,
      preArm: () => undefined,
      release: async () => null,
      onTunnelDropped: async (reason: string) => { onDropped(reason); return null; },
      onTunnelStopped: async () => null,
    } as never,
  };
  return { deps, events, arm, onDropped };
}

const OK_TRACE = 'ip=206.71.158.29\nloc=NL\ncolo=AMS\n';

beforeEach(() => {
  h.startTunGateway.mockReset();
  h.cleanup.mockReset();
  h.closes = [];
  h.startTunGateway.mockImplementation(async () => ({
    ok: true,
    gatewayPort: GATEWAY_PORT,
    run: {
      child: { once: (_event: string, cb: (code: number | null) => void) => { h.closes.push(cb); }, kill: () => true },
      inboundPort: GATEWAY_PORT,
      cleanup: h.cleanup,
      stderrTail: '',
    },
  }));
});

describe('TUN gateway relay verification', () => {
  it('stops the gateway when the TUN path does not relay, and says so', async () => {
    // The hop answers (exit IP verified); the trace THROUGH the gateway does not.
    const { deps, events } = makeDeps(async (port) => {
      if (port === GATEWAY_PORT) throw new Error('TLS handshake through proxy timed out');
      return OK_TRACE;
    });
    const svc = new ProxyTunnelService(deps);
    const s = await svc.start(node(), { systemProxy: false, preferredEngine: 'auto', tun: true });

    // The device is not left holding the default route: process stopped, and the
    // status no longer claims any TUN state at all.
    expect(h.cleanup).toHaveBeenCalledTimes(1);
    expect(s.tun).toBeNull();
    expect(s.tunGatewayPort).toBeNull();
    expect(s.tunBlockedBy).toBe('relay');
    expect(s.tunError).toMatch(/did not relay/);
    expect(s.tunError).toMatch(/stopped/);
    // The proxy hop itself is still verified and serving.
    expect(s.state).toBe('active');
    expect(s.exitIp).toBe('206.71.158.29');
    const degraded = events.find((e) => e.startsWith('tunnel:tun_degraded'));
    expect(degraded).toContain('"blockedBy":"relay"');
    // Nothing armed a route-mode hold over a device that no longer exists.
    expect(events.some((e) => e.startsWith('tunnel:tun_active'))).toBe(false);
  });

  it('excludes the hop host from the TUN route when it starts the gateway', async () => {
    const { deps } = makeDeps(async () => OK_TRACE);
    const svc = new ProxyTunnelService(deps);
    await svc.start(node(), { systemProxy: false, preferredEngine: 'auto', tun: true });

    expect(h.startTunGateway).toHaveBeenCalledTimes(1);
    const args = h.startTunGateway.mock.calls[0] ?? [];
    expect(args[0]).toBe('C:/fake/sing-box.exe');
    expect(args[1]).toBe(HOP_PORT);
    expect(args[4]).toBe('http');
    // The exclusion is the whole point: without it the hop's dial loops.
    expect(args[5]).toEqual([`${NODE_HOST}/32`]);
  });

  it('keeps the gateway and arms route mode when the TUN path provably relays', async () => {
    const { deps, arm } = makeDeps(async () => OK_TRACE);
    const svc = new ProxyTunnelService(deps);
    const s = await svc.start(node(), { systemProxy: false, preferredEngine: 'auto', tun: true });

    expect(s.tun).toBe('active');
    expect(s.tunBlockedBy).toBeNull();
    expect(s.tunGatewayPort).toBe(GATEWAY_PORT);
    expect(h.cleanup).not.toHaveBeenCalled();
    expect(arm).toHaveBeenCalledWith(expect.objectContaining({ mode: 'route' }));
  });

  it('excludes ONLY the entry host in a chain (the exit hop dials loopback, not the node)', async () => {
    // The exit hop of a chain dials its node THROUGH the entry core, so nothing
    // ever dials the exit node's address from this machine. Excluding it anyway
    // would carve a hole in the capture: direct traffic to the exit node's IP
    // would bypass the tunnel entirely.
    const { deps } = makeDeps(async () => OK_TRACE);
    const svc = new ProxyTunnelService(deps);
    const entryHost = '203.0.113.10';
    const exitHost = '198.51.100.20';
    const s = await svc.startNested(
      { entry: node({ id: 'entry', host: entryHost }), exit: node({ id: 'exit', host: exitHost }) },
      { systemProxy: false, preferredEngine: 'auto', tun: true },
    );

    expect(h.startTunGateway).toHaveBeenCalledTimes(1);
    const args = h.startTunGateway.mock.calls[0] ?? [];
    // The device fronts the FINAL hop's inbound port...
    expect(args[1]).toBe(HOP_PORT);
    expect(args[5]).toEqual([`${entryHost}/32`]);
    expect(args[5]).not.toContain(`${exitHost}/32`);
    expect(s.tun).toBe('active');
  });

  it('reports `unguarded` — not `active` — when the hold could not be armed over a live capture', async () => {
    // The kill switch is ON (the user asked for the guarantee) but no service is
    // wired to provide it. The capture is verified and stays up; the STATUS must
    // say the guarantee is missing, because a drop would now fall back to the
    // direct path. This is the case that used to be a log line and nothing else.
    const { deps, events } = makeDeps(async () => OK_TRACE);
    delete (deps as { killSwitch?: unknown }).killSwitch;
    deps.killSwitchEnabled = () => true;
    const svc = new ProxyTunnelService(deps);
    const s = await svc.start(node(), { systemProxy: false, preferredEngine: 'auto', tun: true });

    expect(h.cleanup).not.toHaveBeenCalled(); // traffic really is flowing
    expect(s.tun).toBe('unguarded');
    expect(s.tunBlockedBy).toBe('kill-switch');
    expect(s.tunError).toMatch(/could not be armed/);
    expect(s.tunError).toMatch(/falls back to the direct path/);
    // Every later read of the status keeps saying it, and `active` is never
    // claimed for an unguarded capture.
    expect(svc.getStatus().tun).toBe('unguarded');
    expect(events.some((e) => e.startsWith('tunnel:tun_active'))).toBe(false);
  });

  it('does not invent a missing guard when the kill switch is off', async () => {
    // Nothing was asked for, so nothing is missing: a capture with the
    // preference off is simply active.
    const { deps } = makeDeps(async () => OK_TRACE);
    delete (deps as { killSwitch?: unknown }).killSwitch;
    deps.killSwitchEnabled = () => false;
    const svc = new ProxyTunnelService(deps);
    const s = await svc.start(node(), { systemProxy: false, preferredEngine: 'auto', tun: true });

    expect(s.tun).toBe('active');
    expect(s.tunBlockedBy).toBeNull();
  });

  it('treats a gateway death as a drop: capture withdrawn and the kill switch told', async () => {
    // The gateway owns the default route, so its death withdraws the TUN routes
    // the moment it happens. Reporting `active` afterwards (or leaving the
    // system proxy untouched) would be a silent fallback to the direct path,
    // which is exactly what the route-mode hold exists to prevent.
    const { deps, events, onDropped } = makeDeps(async () => OK_TRACE);
    const svc = new ProxyTunnelService(deps);
    const started = await svc.start(node(), { systemProxy: false, preferredEngine: 'auto', tun: true });
    expect(started.tun).toBe('active');
    expect(h.closes).toHaveLength(1);

    h.closes[0]!(9);

    const after = svc.getStatus();
    expect(after.tun).toBeNull();
    expect(after.tunGatewayPort).toBeNull();
    expect(after.tunError).toBe('TUN gateway exited unexpectedly (code 9)');
    // The engine hop may still be relaying: the tunnel degrades, it does not die.
    expect(after.state).toBe('active');
    expect(onDropped).toHaveBeenCalledWith('TUN gateway exited unexpectedly (code 9)');
    expect(events.some((e) => e.startsWith('tunnel:tun_dropped'))).toBe(true);

    // Then the watchdog does its one bounded re-arm — through this service's own
    // relay seam — and the capture is back, with the healing on the record.
    await vi.waitFor(() => expect(svc.getStatus().tun).toBe('active'));
    expect(events.some((e) => e.startsWith('tunnel:tun_recovering'))).toBe(true);
    expect(events.some((e) => e.startsWith('tunnel:tun_recovered'))).toBe(true);
    expect(svc.getStatus().tunWatchdog).toMatchObject({ autoAttempts: 1, rearming: false, lastError: null });
    expect(h.cleanup).toHaveBeenCalledTimes(1); // the dead device was torn down
  });

  it('does not report a drop when the tunnel is deliberately stopped', async () => {
    const { deps, onDropped } = makeDeps(async () => OK_TRACE);
    const svc = new ProxyTunnelService(deps);
    await svc.start(node(), { systemProxy: false, preferredEngine: 'auto', tun: true });

    await svc.stop();
    expect(h.cleanup).toHaveBeenCalledTimes(1);
    // The kernel/OS closes the killed process a moment later; that is our own
    // teardown, not a crash.
    h.closes[0]?.(0);
    expect(onDropped).not.toHaveBeenCalled();
  });
});
