import { describe, expect, it } from 'vitest';

import { ProxyTunnelService, fetchThroughHttpProxy, stripChunked } from '../src/services/proxyTunnel';

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

function makeDeps(overrides: Partial<TunnelDeps> & { traceBody?: string; traceFail?: Error; core?: FakeCore } = {}) {
  const events: string[] = [];
  const core: FakeCore = overrides.core ?? { closeListeners: [], killed: false };
  let systemProxy: string | null = null;
  const deps: TunnelDeps = {
    nodeVault: null,
    fetchThroughPort: async () => {
      if (overrides.traceFail) throw overrides.traceFail;
      return overrides.traceBody ?? 'ip=185.199.108.153\nloc=NL\ncolo=AMS\n';
    },
    setSystemProxy: async (p) => { systemProxy = p; return { ok: true }; },
    getSystemProxy: async () => ({ proxy: systemProxy }),
    publish: (kind, payload) => events.push(`${kind}:${JSON.stringify(payload)}`),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    findBinary: () => '/fake/xray.exe',
    startCoreFn: async (_engine, _config, _secret, _timeout) => ({
      ok: true,
      run: {
        child: {
          once: (_ev: string, fn: (code: number | null) => void) => { core.closeListeners.push(fn); },
        } as never,
        inboundPort: 45678,
        cleanup: () => { core.killed = true; },
        stderrTail: '',
      },
    }),
    ...overrides,
  };
  return { deps, events, core, getSystemProxy: () => systemProxy };
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
