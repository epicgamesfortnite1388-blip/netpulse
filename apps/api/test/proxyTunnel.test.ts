import { describe, expect, it } from 'vitest';

import { ProxyTunnelService, chainRecord, fetchThroughHttpProxy, stripChunked } from '../src/services/proxyTunnel';

import type { TunnelDeps, TunnelNodeInput } from '../src/services/proxyTunnel';

/**
 * Tunnel contract (Aether-style one-click proxy):
 *   - `active` only after traffic PROVABLY traversed the core (verified exit
 *     IP from a trace fetched THROUGH the tunnel)
 *   - failed verification → state `down`, core killed, system proxy untouched
 *   - crash of a live core → state `down` + bounded auto-reconnect
 *   - stop always restores the previous system proxy
 *   - single-tunnel invariant: starting another node stops the old core
 */

function node(overrides: Partial<TunnelNodeInput> = {}): TunnelNodeInput {
  return {
    id: 'n1',
    protocol: 'vless',
    host: 'node.example',
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

interface FakeCore {
  closeListeners: Array<(code: number | null) => void>;
  killed: boolean;
}

interface StartCall {
  engine: string;
  opts?: { bypass?: unknown; dialThroughPort?: number | null };
  port: number;
}

function makeDeps(
  overrides: Partial<TunnelDeps> & {
    traceBody?: string;
    traceFail?: Error;
    core?: FakeCore;
    /** per-fetch trace bodies, consumed in order; an Error value rejects */
    traces?: Array<string | Error>;
  } = {},
) {
  const events: string[] = [];
  const core: FakeCore = overrides.core ?? { closeListeners: [], killed: false };
  const calls: StartCall[] = [];
  const killedPorts: number[] = [];
  /** close listener per core port, so a nested test can crash ONE hop */
  const closeByPort = new Map<number, Array<(code: number | null) => void>>();
  const ports = [45678, 45679, 45680, 45681];
  let systemProxy: string | null = null;
  const deps: TunnelDeps = {
    nodeVault: null,
    fetchThroughPort: async () => {
      if (overrides.traceFail) throw overrides.traceFail;
      if (overrides.traces) {
        const next = overrides.traces.shift();
        if (next === undefined) throw new Error('no trace body queued for this fetch');
        if (next instanceof Error) throw next;
        return next;
      }
      return overrides.traceBody ?? 'ip=185.199.108.153\nloc=NL\ncolo=AMS\n';
    },
    setSystemProxy: async (p) => { systemProxy = p; return { ok: true }; },
    getSystemProxy: async () => ({ proxy: systemProxy }),
    publish: (kind, payload) => events.push(`${kind}:${JSON.stringify(payload)}`),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    findBinary: () => '/fake/xray.exe',
    startCoreFn: async (engine, _config, _secret, _timeout, opts) => {
      const port = ports[calls.length] ?? 45678;
      calls.push({ engine: engine.id, opts, port });
      const listeners: Array<(code: number | null) => void> = [];
      closeByPort.set(port, listeners);
      return {
        ok: true,
        run: {
          child: {
            once: (_ev: string, fn: (code: number | null) => void) => { listeners.push(fn); core.closeListeners.push(fn); },
          } as never,
          inboundPort: port,
          cleanup: () => { core.killed = true; killedPorts.push(port); },
          stderrTail: '',
        },
      };
    },
    ...overrides,
  };
  return {
    deps,
    events,
    core,
    calls,
    killedPorts,
    /** simulate a crash of the core listening on `port` */
    crash: (port: number) => { for (const fn of closeByPort.get(port) ?? []) fn(1); },
    getSystemProxy: () => systemProxy,
  };
}

describe('ProxyTunnelService', () => {
  it('reaches active only after a verified exit IP through the tunnel', async () => {
    const { deps, events } = makeDeps();
    const svc = new ProxyTunnelService(deps);
    const s = await svc.start(node(), { systemProxy: false, preferredEngine: 'auto' });
    expect(s.state).toBe('active');
    expect(s.exitIp).toBe('185.199.108.153');
    expect(s.exitCountry).toBe('NL');
    expect(s.engine).toBe('xray');
    expect(events.some((e) => e.startsWith('tunnel:active'))).toBe(true);
  });

  it('goes down and kills the core when verification fails (honest failure)', async () => {
    const { deps, core } = makeDeps({ traceFail: new Error('proxy CONNECT rejected: 503') });
    const svc = new ProxyTunnelService(deps);
    const s = await svc.start(node(), { systemProxy: true, preferredEngine: 'auto' });
    expect(s.state).toBe('down');
    expect(s.error).toContain('verification failed');
    expect(core.killed).toBe(true);
  });

  it('hands off the system proxy and restores the previous value on stop', async () => {
    const { deps, getSystemProxy, core } = makeDeps();
    const svc = new ProxyTunnelService(deps);
    await svc.start(node(), { systemProxy: true, preferredEngine: 'auto' });
    expect(getSystemProxy()).toBe('127.0.0.1:45678');
    await svc.stop();
    expect(getSystemProxy()).toBeNull();
    expect(core.killed).toBe(true);
    const after = svc.getStatus();
    expect(after.state).toBe('idle');
    expect(after.systemProxy).toBe(false);
  });

  it('reports down when no installed core supports the protocol', async () => {
    const { deps } = makeDeps({ findBinary: () => null });
    const svc = new ProxyTunnelService(deps);
    const s = await svc.start(node({ protocol: 'hysteria2' }), { systemProxy: false, preferredEngine: 'auto' });
    expect(s.state).toBe('down');
    expect(s.error).toContain('no installed proxy core supports');
  });

  it('reports down when the core fails to start', async () => {
    const { deps } = makeDeps({
      startCoreFn: async () => ({ ok: false as const, failure: 'engine_start_failed' as const, error: 'core exited during startup (code 23)' }),
    });
    const svc = new ProxyTunnelService(deps);
    const s = await svc.start(node(), { systemProxy: false, preferredEngine: 'auto' });
    expect(s.state).toBe('down');
    expect(s.error).toContain('code 23');
  });

  it('enforces the single-tunnel invariant (new start stops the old core)', async () => {
    const first: FakeCore = { closeListeners: [], killed: false };
    const second: FakeCore = { closeListeners: [], killed: false };
    let seq = 0;
    const { deps } = makeDeps({
      startCoreFn: async () => {
        seq += 1;
        const c = seq === 1 ? first : second;
        return {
          ok: true as const,
          run: {
            child: { once: (_ev: string, fn: (code: number | null) => void) => { c.closeListeners.push(fn); } } as never,
            inboundPort: 40000 + seq,
            cleanup: () => { c.killed = true; },
            stderrTail: '',
          },
        };
      },
    });
    const svc = new ProxyTunnelService(deps);
    await svc.start(node({ id: 'a' }), { systemProxy: false, preferredEngine: 'auto' });
    await svc.start(node({ id: 'b' }), { systemProxy: false, preferredEngine: 'auto' });
    expect(first.killed).toBe(true);
    expect(second.killed).toBe(false);
    expect(svc.getStatus().nodeId).toBe('b');
  });

  it('flags down and reconnects (bounded) when the live core crashes', async () => {
    const core: FakeCore = { closeListeners: [], killed: false };
    let generations = 0;
    const { deps, events } = makeDeps({
      core,
      startCoreFn: async () => {
        generations += 1;
        const listeners: Array<(code: number | null) => void> = [];
        core.closeListeners = listeners;
        return {
          ok: true as const,
          run: {
            child: { once: (_ev: string, fn: (code: number | null) => void) => { listeners.push(fn); } } as never,
            inboundPort: 45000 + generations,
            cleanup: () => { /* generation-scoped */ },
            stderrTail: '',
          },
        };
      },
    });
    const svc = new ProxyTunnelService(deps);
    const s0 = await svc.start(node(), { systemProxy: false, preferredEngine: 'auto' });
    expect(s0.state).toBe('active');

    // Simulate a crash of the live core.
    for (const fn of core.closeListeners) fn(1);
    // The close watcher is synchronous → state must be down immediately.
    expect(svc.getStatus().state).toBe('down');

    // Wait out the bounded backoff (1.5s base) + reconnect.
    await new Promise((r) => setTimeout(r, 2_300));
    expect(generations).toBeGreaterThanOrEqual(2);
    expect(svc.getStatus().state).toBe('active');
    expect(events.some((e) => e.startsWith('tunnel:down'))).toBe(true);
    await svc.stop();
  });

  it('stop is safe to call when idle', async () => {
    const { deps } = makeDeps();
    const svc = new ProxyTunnelService(deps);
    const s = await svc.stop();
    expect(s.state).toBe('idle');
  });
});

/**
 * NESTED MODE (Aether-style chain): two cores, the exit dialling its node
 * through the entry. The contract under test is the honest-reporting rule:
 * the reported chain carries the entry edge's own observed address, the final
 * exit address, and a verdict on whether they differ — including when they do
 * not.
 */
describe('ProxyTunnelService nested mode', () => {
  const entryNode = node({ id: 'entry', host: 'entry.example', port: 443, remark: 'Entry NL' });
  const exitNode = node({ id: 'exit', host: 'exit.example', port: 8443, remark: 'Exit JP' });

  it('chains two cores, dials the exit hop through the entry, and reports both observed addresses', async () => {
    const { deps, calls, events } = makeDeps({
      traces: [
        'ip=203.0.113.9\nloc=NL\n', // through the entry core alone
        'ip=198.51.100.7\nloc=JP\n', // through the chained exit
      ],
    });
    const svc = new ProxyTunnelService(deps);
    const s = await svc.startNested({ entry: entryNode, exit: exitNode }, { systemProxy: false, preferredEngine: 'auto' });

    expect(s.state).toBe('active');
    // Two cores: the entry first, then the exit wired to dial through it.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.opts?.dialThroughPort).toBeUndefined();
    expect(calls[1]!.opts?.dialThroughPort).toBe(calls[0]!.port);

    expect(s.nodeId).toBe('exit');
    expect(s.inboundPort).toBe(calls[1]!.port);
    expect(s.chain).not.toBeNull();
    expect(s.chain!.hops.map((h) => h.nodeId)).toEqual(['entry', 'exit']);
    expect(s.chain!.entryExitIp).toBe('203.0.113.9');
    expect(s.chain!.exitIp).toBe('198.51.100.7');
    expect(s.chain!.exitDiffers).toBe(true);
    expect(s.chain!.note).toContain('203.0.113.9');
    expect(s.chain!.note).toContain('198.51.100.7');
    expect(events.some((e) => e.startsWith('tunnel:starting') && e.includes('"nested":true'))).toBe(true);
    expect(events.some((e) => e.startsWith('tunnel:active') && e.includes('"exitDiffers":true'))).toBe(true);
  });

  it('says so when both hops observe the SAME exit address instead of claiming a difference', async () => {
    const { deps } = makeDeps({
      traces: ['ip=203.0.113.9\nloc=NL\n', 'ip=203.0.113.9\nloc=NL\n'],
    });
    const svc = new ProxyTunnelService(deps);
    const s = await svc.startNested({ entry: entryNode, exit: exitNode }, { systemProxy: false, preferredEngine: 'auto' });
    expect(s.state).toBe('active');
    expect(s.chain!.exitDiffers).toBe(false);
    expect(s.chain!.note).toContain('identical');
  });

  it('goes down and kills BOTH cores when the entry hop cannot relay', async () => {
    const { deps, killedPorts } = makeDeps({
      traces: [new Error('proxy CONNECT rejected: 503')],
    });
    const svc = new ProxyTunnelService(deps);
    const s = await svc.startNested({ entry: entryNode, exit: exitNode }, { systemProxy: false, preferredEngine: 'auto' });
    expect(s.state).toBe('down');
    expect(s.error).toContain('entry hop');
    // Nothing is left behind, and the exit core was never even started.
    expect(killedPorts).toEqual([45678]);
  });

  it('stop kills every core of the chain', async () => {
    const { deps, killedPorts, getSystemProxy } = makeDeps({
      traces: ['ip=203.0.113.9\nloc=NL\n', 'ip=198.51.100.7\nloc=JP\n'],
    });
    const svc = new ProxyTunnelService(deps);
    await svc.startNested({ entry: entryNode, exit: exitNode }, { systemProxy: true, preferredEngine: 'auto' });
    expect(getSystemProxy()).toBe('127.0.0.1:45679');
    const s = await svc.stop();
    expect(s.state).toBe('idle');
    expect(s.chain).toBeNull();
    expect(killedPorts).toEqual([45678, 45679]);
    expect(getSystemProxy()).toBeNull();
  });

  it('treats a crash of either hop as the tunnel going down', async () => {
    const { deps, crash } = makeDeps({
      traces: ['ip=203.0.113.9\nloc=NL\n', 'ip=198.51.100.7\nloc=JP\n'],
    });
    const svc = new ProxyTunnelService(deps);
    await svc.startNested({ entry: entryNode, exit: exitNode }, { systemProxy: false, preferredEngine: 'auto' });
    crash(45678); // the ENTRY core dies — the chain is broken too
    expect(svc.getStatus().state).toBe('down');
    expect(svc.getStatus().error).toContain('core exited unexpectedly');
    await svc.stop();
  });

  it('never picks v2ray for the exit hop (its dialerProxy is ignored, so the "chain" would be single-hop)', async () => {
    const { deps, calls } = makeDeps({
      findBinary: (id) => `/fake/${id}.exe`,
      traces: ['ip=203.0.113.9\nloc=NL\n', 'ip=198.51.100.7\nloc=JP\n'],
    });
    const svc = new ProxyTunnelService(deps);
    const s = await svc.startNested({ entry: entryNode, exit: exitNode }, { systemProxy: false, preferredEngine: 'v2ray' });
    expect(s.state).toBe('active');
    // The preference still applies to the entry hop, but the EXIT hop is never
    // v2ray: its dialerProxy is ignored, so the "chain" would be single-hop.
    expect(calls[0]!.engine).toBe('v2ray');
    expect(calls[1]!.engine).toBe('xray');
  });

  it('routes a non-AEAD shadowsocks node around xray, which cannot run that cipher', async () => {
    const { deps, calls } = makeDeps({
      findBinary: (id) => `/fake/${id}.exe`,
      traces: ['ip=203.0.113.9\nloc=NL\n', 'ip=198.51.100.7\nloc=JP\n'],
    });
    const svc = new ProxyTunnelService(deps);
    const s = await svc.startNested(
      { entry: entryNode, exit: node({ id: 'exit', protocol: 'shadowsocks', encryption: 'aes-256-cfb', host: 'exit.example' }) },
      { systemProxy: false, preferredEngine: 'auto' },
    );
    expect(s.state).toBe('active');
    // xray would exit during startup ("unknown cipher method"), so the picker
    // must land on sing-box even though xray comes first by default.
    expect(calls[1]!.engine).toBe('sing-box');
  });

  it('refuses a UDP exit hop with an honest reason rather than a fake chain', async () => {
    const { deps, calls } = makeDeps();
    const svc = new ProxyTunnelService(deps);
    const s = await svc.startNested(
      { entry: entryNode, exit: node({ id: 'exit', protocol: 'hysteria2', host: 'exit.example' }) },
      { systemProxy: false, preferredEngine: 'auto' },
    );
    expect(s.state).toBe('down');
    expect(s.error).toMatch(/UDP-based/);
    expect(calls).toHaveLength(0);
  });
});

describe('chainRecord', () => {
  const hop = (id: string, ip: string | null) => ({
    nodeId: id, name: id, engine: 'xray' as const, host: `${id}.example`, port: 443, exitIp: ip, exitCountry: null, inboundPort: 1,
  });

  it('reports a difference only when one was observed', () => {
    expect(chainRecord(hop('a', '1.1.1.1'), hop('b', '2.2.2.2')).exitDiffers).toBe(true);
    expect(chainRecord(hop('a', '1.1.1.1'), hop('b', '1.1.1.1')).exitDiffers).toBe(false);
  });

  it('cannot claim a difference it did not see', () => {
    const c = chainRecord(hop('a', null), hop('b', '2.2.2.2'));
    expect(c.exitDiffers).toBe(false);
    expect(c.note).toContain('could not be compared');
  });
});

describe('stripChunked', () => {
  it('de-chunks a chunked trace body', () => {
    const raw = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nip=\r\nf\r\n185.199.108.153\r\n0\r\n\r\n';
    expect(stripChunked(raw)).toContain('ip=185.199.108.153');
  });

  it('passes through non-chunked bodies', () => {
    expect(stripChunked('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello')).toBe('hello');
  });
});

describe('tunnel audit fixes', () => {
  it('does not touch the system proxy when verification fails (user proxy preserved)', async () => {
    let proxyWrites = 0;
    const { deps } = makeDeps({
      traceFail: new Error('proxy CONNECT rejected: 503'),
      setSystemProxy: async (p) => { proxyWrites += 1; return { ok: true }; },
    });
    const svc = new ProxyTunnelService(deps);
    const s = await svc.start(node(), { systemProxy: true, preferredEngine: 'auto' });
    expect(s.state).toBe('down');
    // Verification failed before any handoff → we must not write the registry at all.
    expect(proxyWrites).toBe(0);
  });

  it('a stop() issued while a restart is pending wins (no resurrection)', async () => {
    const core: FakeCore = { closeListeners: [], killed: false };
    let generations = 0;
    const { deps } = makeDeps({
      core,
      startCoreFn: async () => {
        generations += 1;
        const listeners: Array<(code: number | null) => void> = [];
        core.closeListeners = listeners;
        return {
          ok: true as const,
          run: {
            child: { once: (_ev: string, fn: (code: number | null) => void) => { listeners.push(fn); } } as never,
            inboundPort: 46000 + generations,
            cleanup: () => { /* gen-scoped */ },
            stderrTail: '',
          },
        };
      },
    });
    const svc = new ProxyTunnelService(deps);
    await svc.start(node(), { systemProxy: false, preferredEngine: 'auto' });
    for (const fn of core.closeListeners) fn(1); // crash → restart queued (1.5s)
    // Stop while the restart timer is pending.
    await new Promise((r) => setTimeout(r, 200));
    await svc.stop();
    const genAtStop = generations;
    // Wait past the queued restart delay: it must NOT come back.
    await new Promise((r) => setTimeout(r, 2_200));
    expect(generations).toBe(genAtStop);
    expect(svc.getStatus().state).toBe('idle');
  });

  it('verification failure leaves the previous system proxy untouched even with systemProxy:true', async () => {
    let written: string | null | undefined;
    const { deps } = makeDeps({
      traceFail: new Error('TLS through proxy timed out'),
      setSystemProxy: async (p) => { written = p; return { ok: true }; },
      getSystemProxy: async () => ({ proxy: '10.0.0.1:8080' }),
    });
    const svc = new ProxyTunnelService(deps);
    const s = await svc.start(node(), { systemProxy: true, preferredEngine: 'auto' });
    expect(s.state).toBe('down');
    expect(written).toBeUndefined();
  });
});

describe('ProxyTunnelService queue semantics (rapid switches)', () => {
  it('a start queued behind a failing start still runs — a failure never drops a user switch', async () => {
    // The user picks node A, then immediately switches to node B while A is
    // still starting. A's verification trace fails. B was queued behind A and
    // must still run: `stopGeneration` is only for deliberate stops, and the
    // restart fence is separate — previously a failed start bumped the stop
    // generation and B was silently discarded, answered with A's failure.
    const { deps } = makeDeps({
      traces: [new Error('trace refused'), 'ip=203.0.113.77\nloc=DE\ncolo=Fra\n'],
    });
    const svc = new ProxyTunnelService(deps);
    const a = svc.start(node({ id: 'nA' }), { systemProxy: false, preferredEngine: 'auto' });
    const b = svc.start(node({ id: 'nB' }), { systemProxy: false, preferredEngine: 'auto' });
    const [sa, sb] = await Promise.all([a, b]);

    expect(sa.state).toBe('down');
    expect(sa.error, 'the first candidate should fail verification').toContain('verification failed');
    expect(sb.state, 'the queued switch was dropped by the previous candidate failure').toBe('active');
    expect(sb.nodeId).toBe('nB');
  });

  it('a start queued behind a SUCCESSFUL start still runs (the switch lands)', async () => {
    // The same race without a failure: A comes up, B is queued. B must tear
    // A down and take over — the single-tunnel invariant, held across the
    // queue rather than only across sequential awaits.
    const { deps, killedPorts } = makeDeps({
      traces: ['ip=203.0.113.1\nloc=NL\ncolo=AMS\n', 'ip=198.51.100.20\nloc=DE\ncolo=Fra\n'],
    });
    const svc = new ProxyTunnelService(deps);
    const a = svc.start(node({ id: 'nA' }), { systemProxy: false, preferredEngine: 'auto' });
    const b = svc.start(node({ id: 'nB' }), { systemProxy: false, preferredEngine: 'auto' });
    const [sa, sb] = await Promise.all([a, b]);

    expect(sa.state).toBe('active');
    expect(sb.state).toBe('active');
    expect(sb.nodeId).toBe('nB');
    expect(killedPorts, 'the first core was not torn down by the switch').toContain(45678);
  });
});
