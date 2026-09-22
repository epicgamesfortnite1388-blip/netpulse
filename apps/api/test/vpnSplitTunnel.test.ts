import { describe, expect, it } from 'vitest';

import { normalizeBypass } from '@netpulse/shared';

import {
  buildSingboxConfig,
  buildSingboxRouteRules,
  buildXrayConfig,
  buildXrayRoutingRules,
  XRAY_PRIVATE_CIDRS,
} from '../src/services/proxyCores';
import { ProxyTunnelService } from '../src/services/proxyTunnel';

import type { ParsedNodeConfig } from '@netpulse/shared';
import type { TunnelDeps, TunnelNodeInput } from '../src/services/proxyTunnel';

/**
 * Split-tunnel contract:
 *   - a bypass rule set produces a `direct` outbound plus routing rules on the
 *     LONG-LIVED tunnel core, and domain rules must match subdomains
 *   - private/LAN ranges get their own rule (an AND-folded matcher would apply
 *     to far more traffic than intended)
 *   - probe/test configs NEVER carry bypass — a test that skipped the node
 *     would be measuring a different path than the one it claims to measure
 */

function cfg(overrides: Partial<ParsedNodeConfig> = {}): ParsedNodeConfig {
  return {
    protocol: 'vless',
    host: 'example.com',
    port: 443,
    transport: 'ws',
    security: 'tls',
    sni: 'cdn.example.com',
    path: '/wspath',
    ...overrides,
  };
}

const rules = normalizeBypass({
  enabled: true,
  domains: ['bank.example.com', 'stream.example'],
  ips: ['10.0.0.0/8'],
  ports: [443],
  lan: true,
});

describe('xray split-tunnel routing', () => {
  it('the probe config has no routing block at all', () => {
    const probe = buildXrayConfig(cfg(), 'u', 41234);
    expect(probe['routing']).toBeUndefined();
    expect((probe['outbounds'] as unknown[]).length).toBe(1);
  });

  it('a bypass set adds a freedom/direct outbound and the field rule', () => {
    const tunnel = buildXrayConfig(cfg(), 'u', 41234, rules);
    const outbounds = tunnel['outbounds'] as Array<Record<string, unknown>>;
    expect(outbounds).toHaveLength(2);
    expect(outbounds[1]).toMatchObject({ protocol: 'freedom', tag: 'direct' });

    const routing = tunnel['routing'] as { rules: Array<Record<string, unknown>> };
    expect(routing.rules).toHaveLength(1);
    const rule = routing.rules[0]!;
    expect(rule['outboundTag']).toBe('direct');
    // `domain:` matches the name AND its subdomains in xray — the semantics
    // the settings UI promises.
    expect(rule['domain']).toEqual(['domain:bank.example.com', 'domain:stream.example']);
    // Explicit private CIDRs — geoip:private would need geoip.dat beside the
    // exe, which the app never ships (observed live: xray exit 23).
    expect(rule['ip']).toEqual(['10.0.0.0/8', ...XRAY_PRIVATE_CIDRS]);
    expect(rule['port']).toBe('443');
  });

  it('LAN-only bypass emits a private-range rule and nothing else', () => {
    const lanOnly = buildXrayRoutingRules({ domains: [], ips: [], ports: [], lan: true });
    expect(lanOnly).toEqual([{ type: 'field', outboundTag: 'direct', ip: [...XRAY_PRIVATE_CIDRS] }]);
    expect(buildXrayRoutingRules({ domains: [], ips: [], ports: [], lan: false })).toEqual([]);
  });
});

describe('sing-box split-tunnel routing', () => {
  it('the probe config has no direct outbound and no route rules', () => {
    const probe = buildSingboxConfig(cfg(), 'u', 45678);
    expect((probe['outbounds'] as unknown[]).length).toBe(1);
    const route = probe['route'] as Record<string, unknown>;
    expect(route['rules']).toBeUndefined();
    expect(route['auto_detect_interface']).toBe(true);
  });

  it('a bypass set adds a direct outbound and routes domains/ips/ports to it', () => {
    const tunnel = buildSingboxConfig(cfg(), 'u', 45678, rules);
    const outbounds = tunnel['outbounds'] as Array<Record<string, unknown>>;
    expect(outbounds).toHaveLength(2);
    expect(outbounds[1]).toMatchObject({ type: 'direct', tag: 'direct' });

    const route = tunnel['route'] as { rules: Array<Record<string, unknown>> };
    expect(route.rules[0]).toMatchObject({
      domain_suffix: ['bank.example.com', 'stream.example'],
      ip_cidr: ['10.0.0.0/8'],
      port: [443],
      outbound: 'direct',
    });
  });

  it('keeps private ranges in their OWN rule rather than folding them in', () => {
    const built = buildSingboxRouteRules(rules);
    expect(built).toHaveLength(2);
    expect(built[1]).toEqual({ ip_is_private: true, outbound: 'direct' });
    // the combined rule must not carry the private matcher
    expect(built[0]!['ip_is_private']).toBeUndefined();
  });
});

/* ------------------------- tunnel wiring (not just the builder) ----------- */

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
    remark: 'Tokyo node',
    ...overrides,
  };
}

function harness(traceBody = 'ip=203.0.113.9\nloc=JP\n') {
  const seenBypass: Array<{ bypass?: unknown } | undefined> = [];
  const deps: TunnelDeps = {
    nodeVault: null,
    fetchThroughPort: async () => traceBody,
    setSystemProxy: async () => ({ ok: true }),
    getSystemProxy: async () => ({ proxy: null }),
    publish: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    findBinary: () => '/fake/xray.exe',
    startCoreFn: async (_engine, _config, _secret, _timeout, opts) => {
      seenBypass.push(opts);
      return {
        ok: true,
        run: {
          child: { once: () => {} } as never,
          inboundPort: 45678,
          cleanup: () => {},
          stderrTail: '',
        },
      };
    },
  };
  return { deps, seenBypass };
}

describe('the tunnel applies bypass, the probe path does not', () => {
  it('passes normalized rules to the core and reports them in status', async () => {
    const { deps, seenBypass } = harness();
    const tunnel = new ProxyTunnelService(deps);
    const status = await tunnel.start(node(), { systemProxy: false, preferredEngine: 'xray', bypass: rules });
    expect(seenBypass[0]?.bypass).toEqual(rules);
    expect(status.state).toBe('active');
    expect(status.bypass).toBe('2 domains, 1 address, 1 port, LAN');
    expect(status.nodeName).toBe('Tokyo node');
  });

  it('sends no bypass when none is configured, and reports none', async () => {
    const { deps, seenBypass } = harness();
    const tunnel = new ProxyTunnelService(deps);
    const status = await tunnel.start(node(), { systemProxy: false, preferredEngine: 'xray', bypass: null });
    expect(seenBypass[0]?.bypass).toBeNull();
    expect(status.bypass).toBeNull();
  });

  it('treats an empty rule set as no bypass (no empty routing block)', async () => {
    const { deps, seenBypass } = harness();
    const tunnel = new ProxyTunnelService(deps);
    const empty = normalizeBypass({ enabled: true, domains: [], ips: [], ports: [], lan: false });
    await tunnel.start(node(), { systemProxy: false, preferredEngine: 'xray', bypass: empty });
    expect(seenBypass[0]?.bypass).toBeNull();
  });

  it('uses the shared status vocabulary so the UI can render it directly', async () => {
    const { deps } = harness();
    const tunnel = new ProxyTunnelService(deps);
    const status = await tunnel.start(node(), { systemProxy: false, preferredEngine: 'xray', source: 'gateway-memory' });
    expect(status.source).toBe('gateway-memory');
    expect(status.reconnectLimit).toBe(3);
    expect(status.reconnectAttempts).toBe(0);
  });
});
