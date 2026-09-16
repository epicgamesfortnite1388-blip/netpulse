import { describe, expect, it } from 'vitest';

import { GatewayMemoryService, type GatewayStore } from '../src/services/gatewayMemory';
import { ProxyTunnelService } from '../src/services/proxyTunnel';

import type { GatewaySuccessInput } from '@netpulse/shared';
import type { TunnelDeps, TunnelNodeInput } from '../src/services/proxyTunnel';

/**
 * Gateway memory contract:
 *   - only a VERIFIED tunnel start is recorded (traffic provably traversed)
 *   - a gateway that later fails verification is demoted, not deleted
 *   - the list survives a restart and degrades to empty on a corrupt blob
 *   - a write failure never breaks the tunnel
 */

function fakeStore(initial: Record<string, unknown> | null = null, failWrites = false) {
  let stored = initial;
  const store: GatewayStore = {
    get: () => stored,
    put: (_key, value) => {
      if (failWrites) throw new Error('disk full');
      stored = value;
    },
  };
  return { store, raw: () => stored };
}

const success: GatewaySuccessInput = {
  nodeId: 'n1',
  name: 'Tokyo node',
  host: '1.2.3.4',
  port: 443,
  protocol: 'vless',
  engine: 'xray',
  exitIp: '203.0.113.9',
  exitCountry: 'JP',
  verifyMs: 120,
};

describe('GatewayMemoryService', () => {
  it('remembers a verified gateway and survives a restart', () => {
    const { store } = fakeStore();
    const svc = new GatewayMemoryService({ store });
    svc.remember(success, 1_000);

    // fresh instance reading the same store = a process restart
    const afterRestart = new GatewayMemoryService({ store });
    const list = afterRestart.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ nodeId: 'n1', exitIp: '203.0.113.9', engine: 'xray' });
  });

  it('demotes a gateway whose verification later fails', () => {
    const { store } = fakeStore();
    const svc = new GatewayMemoryService({ store });
    svc.remember({ ...success, nodeId: 'good' }, 1_000);
    svc.remember({ ...success, nodeId: 'bad' }, 2_000);

    svc.markFailed('bad', 3_000);
    const ranked = svc.ranked(3_100);
    expect(ranked[0]!.nodeId).toBe('good');
    const bad = svc.list().find((e) => e.nodeId === 'bad')!;
    expect(bad.successStreak).toBe(0);
    expect(bad.failCount).toBe(1);
    expect(bad.exitIp).toBe('203.0.113.9'); // last known evidence is kept
  });

  it('ignores a failure for a gateway it does not remember', () => {
    const { store } = fakeStore();
    const svc = new GatewayMemoryService({ store });
    svc.markFailed('never-seen', 1_000);
    expect(svc.list()).toEqual([]);
  });

  it('forgets one gateway, or everything', () => {
    const { store } = fakeStore();
    const svc = new GatewayMemoryService({ store });
    svc.remember({ ...success, nodeId: 'a' }, 1_000);
    svc.remember({ ...success, nodeId: 'b' }, 2_000);
    expect(svc.forget('a').map((e) => e.nodeId)).toEqual(['b']);
    expect(svc.forget()).toEqual([]);
    expect(new GatewayMemoryService({ store }).list()).toEqual([]);
  });

  it('degrades to empty on a corrupt blob instead of throwing', () => {
    const { store } = fakeStore({ entries: 'not-an-array' });
    const svc = new GatewayMemoryService({ store });
    expect(svc.list()).toEqual([]);
  });

  it('keeps working in-process when the store write fails', () => {
    const { store } = fakeStore(null, true);
    const warnings: string[] = [];
    const svc = new GatewayMemoryService({ store, log: { warn: (m) => warnings.push(m) } });
    svc.remember(success, 1_000);
    expect(svc.list()).toHaveLength(1);
    expect(warnings.some((w) => w.includes('write failed'))).toBe(true);
  });
});

/* --------------------------- tunnel integration --------------------------- */

function node(): TunnelNodeInput {
  return {
    id: 'n1', protocol: 'vless', host: 'node.example', port: 443, transport: 'tcp',
    security: 'tls', sni: null, alpn: null, fingerprint: null, flow: null, alterId: null,
    path: null, hostHeader: null, serviceName: null, allowInsecure: null, encryption: null,
    ssrProtocol: null, realityPublicKey: null, realityShortId: null, realityServerName: null,
    remark: 'Tokyo node',
  };
}

function tunnelDeps(traceBody: string | null, traceError?: Error) {
  const verified: GatewaySuccessInput[] = [];
  const failed: string[] = [];
  const deps: TunnelDeps = {
    nodeVault: null,
    fetchThroughPort: async () => {
      if (traceError) throw traceError;
      return traceBody ?? '';
    },
    setSystemProxy: async () => ({ ok: true }),
    getSystemProxy: async () => ({ proxy: null }),
    publish: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    findBinary: () => '/fake/xray.exe',
    startCoreFn: async () => ({
      ok: true,
      run: {
        child: { once: () => {} } as never,
        inboundPort: 45678,
        cleanup: () => {},
        stderrTail: '',
      },
    }),
    onVerifiedGateway: (input) => verified.push(input),
    onGatewayFailed: (id) => failed.push(id),
  };
  return { deps, verified, failed };
}

describe('gateway memory is written from the verified path only', () => {
  it('records the gateway after a proven exit IP, with the exit evidence', async () => {
    const { deps, verified, failed } = tunnelDeps('ip=203.0.113.9\nloc=JP\n');
    const tunnel = new ProxyTunnelService(deps);
    const status = await tunnel.start(node(), { systemProxy: false, preferredEngine: 'xray' });
    expect(status.state).toBe('active');
    expect(verified).toHaveLength(1);
    expect(verified[0]).toMatchObject({ nodeId: 'n1', exitIp: '203.0.113.9', exitCountry: 'JP', name: 'Tokyo node' });
    expect(failed).toEqual([]);
  });

  it('records NOTHING when the tunnel could not relay traffic', async () => {
    const { deps, verified, failed } = tunnelDeps(null, new Error('trace fetch failed'));
    const tunnel = new ProxyTunnelService(deps);
    const status = await tunnel.start(node(), { systemProxy: false, preferredEngine: 'xray' });
    expect(status.state).toBe('down');
    expect(verified).toEqual([]); // never remembered
    expect(failed).toEqual(['n1']); // and demoted if it was remembered before
  });

  it('records nothing when the trace has no ip= line', async () => {
    const { deps, verified } = tunnelDeps('warp=on\ncolo=AMS\n');
    const tunnel = new ProxyTunnelService(deps);
    const status = await tunnel.start(node(), { systemProxy: false, preferredEngine: 'xray' });
    expect(status.state).toBe('down');
    expect(verified).toEqual([]);
  });
});
